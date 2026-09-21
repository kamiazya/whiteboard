/**
 * The read plane's per-workspace content key store (ADR-0042 decisions
 * 1/3/5, ADR-0043 decision 3). Mint-once, injective across workspaces, and
 * concurrent-mint-once are pinned as example tests AND a property so a
 * regression that only shows up for one particular workspaceId shape does
 * not slip past a fixed pair of example ids.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../../shared/test-utils/fast-check.js'
import { createIsolatedDb, type IsolatedDbHandle } from '../store/db/test-helpers.js'
import { cloneBytes } from '../store/inmemory/clone-bytes.js'
import {
  createWorkspaceReplicaKeyStore,
  type WorkspaceReplicaKeyStore,
} from './workspace-replica-key-store.js'

let handle: IsolatedDbHandle
let store: WorkspaceReplicaKeyStore

beforeEach(async () => {
  handle = await createIsolatedDb({ dataDir: '/tmp/workspace-replica-key-store-unused' })
  store = createWorkspaceReplicaKeyStore(handle.db, { defaultTier: 'offline' })
})

afterEach(async () => {
  await handle.dispose()
})

async function insertWorkspace(id: string, replicaTier: string | null = null) {
  await handle.db
    .insertInto('workspaces')
    .values({ id, displayName: null, segment: null, createdAt: 0, updatedAt: 0, replicaTier })
    .execute()
}

describe('keyFor', () => {
  it('mints once and answers the identical key+salt on later calls', async () => {
    const first = await store.keyFor('ws-1')
    const second = await store.keyFor('ws-1')
    expect(second.key).toEqual(first.key)
    expect(second.salt).toEqual(first.salt)
  })

  it('gives two workspaces different keys', async () => {
    const a = await store.keyFor('ws-a')
    const b = await store.keyFor('ws-b')
    expect(a.key).not.toEqual(b.key)
  })

  it('mints a 32-byte key and a 16-byte salt', async () => {
    const { key, salt } = await store.keyFor('ws-1')
    expect(key.length).toBe(32)
    expect(salt.length).toBe(16)
  })

  // The race is real at the JS level (every keyFor call starts before any
  // insert resolves), though libsql serialises statements on one connection
  // — so this proves the onConflict path answers correctly under
  // interleaving rather than true multi-connection contention. Both the
  // convergent result AND the row count are asserted: a store that silently
  // swallowed a losing insert's error would still pass on result alone.
  it('concurrent keyFor calls for the same workspace converge to one key and one row', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => store.keyFor('ws-race')))
    for (const result of results) {
      expect(result.key).toEqual(results[0]?.key)
      expect(result.salt).toEqual(results[0]?.salt)
    }
    const rows = await handle.db
      .selectFrom('workspaceReplicaKeys')
      .selectAll()
      .where('workspaceId', '=', 'ws-race')
      .execute()
    expect(rows).toHaveLength(1)
  })

  fcTest.prop(
    [fc.uniqueArray(fc.string({ minLength: 1, maxLength: 24 }), { minLength: 2, maxLength: 6 })],
    withDefaults({ numRuns: 30 }),
  )('is per-id stable and pairwise injective across distinct workspaceIds', async (ids) => {
    const first = new Map<string, WorkspaceReplicaKey>()
    for (const id of ids) first.set(id, await store.keyFor(id))
    for (const id of ids) {
      const again = await store.keyFor(id)
      expect(again.key).toEqual(first.get(id)?.key)
    }
    const keys = [...first.values()].map((k) => Buffer.from(k.key).toString('base64url'))
    expect(new Set(keys).size).toBe(keys.length)
  })
})

interface WorkspaceReplicaKey {
  key: Uint8Array
  salt: Uint8Array
}

describe('tierFor / effectiveTier', () => {
  it('is null when unset', async () => {
    await insertWorkspace('ws-1')
    expect(await store.tierFor('ws-1')).toBeNull()
  })

  it('answers the stored value when set', async () => {
    await insertWorkspace('ws-1', 'bounded')
    expect(await store.tierFor('ws-1')).toBe('bounded')
  })

  it('is null for a workspace row that does not exist at all', async () => {
    expect(await store.tierFor('no-such-workspace')).toBeNull()
  })

  it('effectiveTier falls back to the constructor default when unset', async () => {
    await insertWorkspace('ws-1')
    expect(await store.effectiveTier('ws-1')).toBe('offline')
  })

  it('effectiveTier prefers the per-workspace override over the default', async () => {
    await insertWorkspace('ws-1', 'no-offline')
    expect(await store.effectiveTier('ws-1')).toBe('no-offline')
  })

  it('throws on a stored tier value that is not one of the declared enum members', async () => {
    await insertWorkspace('ws-1', 'quantum-offline')
    await expect(store.tierFor('ws-1')).rejects.toThrow()
  })
})

describe('setTier', () => {
  it.for([
    'no-offline',
    'offline',
    'bounded',
  ] as const)('round-trips %s through tierFor and effectiveTier', async (tier) => {
    await insertWorkspace('ws-1')
    expect(await store.setTier('ws-1', tier)).toBe(true)
    expect(await store.tierFor('ws-1')).toBe(tier)
    expect(await store.effectiveTier('ws-1')).toBe(tier)
  })

  it('clearing back to null falls back to the constructor default', async () => {
    await insertWorkspace('ws-1', 'no-offline')
    expect(await store.setTier('ws-1', null)).toBe(true)
    expect(await store.tierFor('ws-1')).toBeNull()
    expect(await store.effectiveTier('ws-1')).toBe('offline')
  })

  it('rejects a value outside the declared enum and leaves the column unchanged', async () => {
    await insertWorkspace('ws-1', 'offline')
    // @ts-expect-error — exercising the runtime guard against a caller that
    // bypasses the type system, the same hazard `tierFor` guards on read.
    await expect(store.setTier('ws-1', 'session')).rejects.toThrow()
    expect(await store.tierFor('ws-1')).toBe('offline')
  })

  it('answers false for a workspace with no registry row, and creates none', async () => {
    expect(await store.setTier('no-such-workspace', 'offline')).toBe(false)
    expect(await store.tierFor('no-such-workspace')).toBeNull()
  })

  it('is idempotent and touches no other column', async () => {
    await handle.db
      .insertInto('workspaces')
      .values({
        id: 'ws-1',
        displayName: 'Ada',
        segment: 'ada',
        createdAt: 111,
        updatedAt: 222,
        replicaTier: null,
      })
      .execute()
    await store.setTier('ws-1', 'bounded')
    await store.setTier('ws-1', 'bounded')
    const row = await handle.db
      .selectFrom('workspaces')
      .selectAll()
      .where('id', '=', 'ws-1')
      .executeTakeFirstOrThrow()
    expect(row).toEqual({
      id: 'ws-1',
      displayName: 'Ada',
      segment: 'ada',
      createdAt: 111,
      updatedAt: 222,
      replicaTier: 'bounded',
    })
  })

  it('leaves the key-table untouched by a tier write, in both directions', async () => {
    await insertWorkspace('ws-1')
    await store.setTier('ws-1', 'no-offline')
    expect(
      await handle.db
        .selectFrom('workspaceReplicaKeys')
        .selectAll()
        .where('workspaceId', '=', 'ws-1')
        .execute(),
    ).toEqual([])

    const minted = await store.keyFor('ws-1')
    await store.setTier('ws-1', null)
    const afterClear = await handle.db
      .selectFrom('workspaceReplicaKeys')
      .selectAll()
      .where('workspaceId', '=', 'ws-1')
      .executeTakeFirstOrThrow()
    expect(cloneBytes(afterClear.key)).toEqual(minted.key)
  })
})
