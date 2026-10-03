/**
 * The registry's enumeration and its one remover.
 *
 * `listReplicas` exists because the Settings list of local copies cannot be
 * built from the byte store: `IdbDocumentStore` has no list method, so the
 * inventory comes from this registry and the browser workspace rows, which
 * are disjoint sets.
 *
 * `forgetReplicaEntry` exists because nothing removed a key at all — the
 * registry only ever grew. Its own schema comment says a missing entry means
 * "claim no cache", never "the bytes are gone", which is exactly why
 * deleting a copy is two steps and this is only the first.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import {
  findReplicaForHandle,
  forgetReplicaEntry,
  listReplicas,
  pulledReplicaFields,
  sealedUnderSupersededKey,
  withReplicaEntry,
} from './replicas.js'
import {
  createUserSettingsStore,
  defaultUserSettings,
  type UserSettings,
} from './user-settings-store.js'

function settingsWith(
  entries: { workspaceId: string; daemonBaseUrl: string; syncedAt: string; segment?: string }[],
): UserSettings {
  const store = createUserSettingsStore()
  let settings = store.load()
  for (const { workspaceId, ...entry } of entries) {
    settings = withReplicaEntry(settings, workspaceId, entry)
  }
  return settings
}

beforeEach(() => {
  createUserSettingsStore().reset()
})

describe('listReplicas', () => {
  it('answers an empty list when the registry has never been written', () => {
    expect(listReplicas(createUserSettingsStore().load())).toEqual([])
  })

  it('answers one entry per key, with the workspace id folded in', () => {
    const settings = settingsWith([
      {
        workspaceId: 'ws-a',
        daemonBaseUrl: 'http://127.0.0.1:3099',
        syncedAt: '2026-09-20T00:00:00.000Z',
        segment: 'alpha',
      },
      {
        workspaceId: 'ws-b',
        daemonBaseUrl: 'http://127.0.0.1:4000',
        syncedAt: '2026-09-21T00:00:00.000Z',
      },
    ])

    const listed = listReplicas(settings)

    expect(listed).toHaveLength(2)
    // The key is not a field of the stored value, so folding it in is the
    // whole point: a caller holding a row must be able to name the record.
    expect(listed.map((entry) => entry.workspaceId).sort()).toEqual(['ws-a', 'ws-b'])
    expect(listed.find((entry) => entry.workspaceId === 'ws-a')?.segment).toBe('alpha')
    expect(listed.find((entry) => entry.workspaceId === 'ws-b')?.daemonBaseUrl).toBe(
      'http://127.0.0.1:4000',
    )
  })

  it('agrees with the single lookup for every entry it answers', () => {
    const settings = settingsWith([
      {
        workspaceId: 'ws-a',
        daemonBaseUrl: 'http://127.0.0.1:3099',
        syncedAt: '2026-09-20T00:00:00.000Z',
        segment: 'alpha',
      },
    ])

    for (const entry of listReplicas(settings)) {
      expect(findReplicaForHandle(settings, entry.workspaceId)).toEqual(entry)
    }
  })
})

describe('forgetReplicaEntry', () => {
  it('removes exactly the named key and leaves the others', () => {
    const settings = settingsWith([
      {
        workspaceId: 'ws-a',
        daemonBaseUrl: 'http://127.0.0.1:3099',
        syncedAt: '2026-09-20T00:00:00.000Z',
      },
      {
        workspaceId: 'ws-b',
        daemonBaseUrl: 'http://127.0.0.1:3099',
        syncedAt: '2026-09-21T00:00:00.000Z',
      },
    ])

    const next = forgetReplicaEntry(settings, 'ws-a')

    expect(listReplicas(next).map((entry) => entry.workspaceId)).toEqual(['ws-b'])
    expect(findReplicaForHandle(next, 'ws-a')).toBeNull()
  })

  it('leaves every other setting untouched', () => {
    const before = settingsWith([
      {
        workspaceId: 'ws-a',
        daemonBaseUrl: 'http://127.0.0.1:3099',
        syncedAt: '2026-09-20T00:00:00.000Z',
      },
    ])

    const next = forgetReplicaEntry(before, 'ws-a')

    // The loader falls back to defaults on ANY parse failure, so a remover
    // that reshaped the payload would discard a reader's whole settings
    // rather than one entry — and the loss would be silent.
    expect({ ...next, storage: { ...next.storage, replicas: undefined } }).toEqual({
      ...before,
      storage: { ...before.storage, replicas: undefined },
    })
  })

  it('is a no-op for an id the registry does not hold', () => {
    const before = settingsWith([
      {
        workspaceId: 'ws-a',
        daemonBaseUrl: 'http://127.0.0.1:3099',
        syncedAt: '2026-09-20T00:00:00.000Z',
      },
    ])

    expect(forgetReplicaEntry(before, 'ws-missing')).toEqual(before)
  })

  it('survives a real save and load, so the removal is what a later reader sees', () => {
    const store = createUserSettingsStore()
    store.save(
      settingsWith([
        {
          workspaceId: 'ws-a',
          daemonBaseUrl: 'http://127.0.0.1:3099',
          syncedAt: '2026-09-20T00:00:00.000Z',
        },
        {
          workspaceId: 'ws-b',
          daemonBaseUrl: 'http://127.0.0.1:3099',
          syncedAt: '2026-09-21T00:00:00.000Z',
        },
      ]),
    )

    store.update((current) => forgetReplicaEntry(current, 'ws-a'))

    expect(listReplicas(createUserSettingsStore().load()).map((e) => e.workspaceId)).toEqual([
      'ws-b',
    ])
  })
})

describe('a replica entry written in two steps', () => {
  const pulled = withReplicaEntry(defaultUserSettings(), 'ws-1', {
    daemonBaseUrl: 'http://d',
    syncedAt: '2026-01-01T00:00:00Z',
    segment: 'team',
    displayName: 'Team',
    syncedFrontier: 'f1',
  })

  it('records the segment and display name a pull captured', () => {
    expect(findReplicaForHandle(pulled, 'team')?.displayName).toBe('Team')
  })

  it('keeps them when a later push states only what it synced', () => {
    const pushed = withReplicaEntry(pulled, 'ws-1', {
      daemonBaseUrl: 'http://d',
      syncedAt: '2026-01-02T00:00:00Z',
      syncedFrontier: 'f2',
    })

    expect(findReplicaForHandle(pushed, 'team')).toMatchObject({
      workspaceId: 'ws-1',
      displayName: 'Team',
      syncedAt: '2026-01-02T00:00:00Z',
      syncedFrontier: 'f2',
    })
  })

  it('does not invent a frontier an entry never recorded', () => {
    const withoutFrontier = withReplicaEntry(defaultUserSettings(), 'ws-1', {
      daemonBaseUrl: 'http://d',
      syncedAt: '2026-01-01T00:00:00Z',
    })

    expect(withoutFrontier.storage.replicas?.['ws-1']).toEqual({
      daemonBaseUrl: 'http://d',
      syncedAt: '2026-01-01T00:00:00Z',
    })
  })

  it('forgetting a workspace the registry never held answers the same settings object', () => {
    expect(forgetReplicaEntry(pulled, 'nope')).toBe(pulled)
    expect(forgetReplicaEntry(defaultUserSettings(), 'nope')).toEqual(defaultUserSettings())
  })

  it('finds an entry by its canonical id or by its segment, and nothing else', () => {
    expect(findReplicaForHandle(pulled, 'ws-1')?.workspaceId).toBe('ws-1')
    expect(findReplicaForHandle(pulled, 'team')?.workspaceId).toBe('ws-1')
    expect(findReplicaForHandle(pulled, 'nobody')).toBeNull()
    expect(findReplicaForHandle(defaultUserSettings(), 'ws-1')).toBeNull()
  })
})

describe('the key generation a copy is sealed under', () => {
  it('is superseded only when both the copy and the held key name a generation and they differ', () => {
    expect(sealedUnderSupersededKey('A', 'B')).toBe(true)
    expect(sealedUnderSupersededKey('A', 'A')).toBe(false)
    // Either side silent means "cannot tell", which must read as not superseded.
    expect(sealedUnderSupersededKey(undefined, 'B')).toBe(false)
    expect(sealedUnderSupersededKey('A', undefined)).toBe(false)
    expect(sealedUnderSupersededKey(undefined, undefined)).toBe(false)
  })

  it('rides the registry entry, survives a later writer that does not know it, and is replaced by a newer one', () => {
    const base = defaultUserSettings()
    const first = withReplicaEntry(base, 'ws-1', {
      daemonBaseUrl: 'http://d',
      ...pulledReplicaFields({ syncedAt: '2026-01-01T00:00:00Z', syncedFrontier: 'f', keyId: 'A' }),
    })
    expect(findReplicaForHandle(first, 'ws-1')?.keyId).toBe('A')

    const pushed = withReplicaEntry(first, 'ws-1', {
      daemonBaseUrl: 'http://d',
      syncedAt: '2026-01-02T00:00:00Z',
    })
    expect(findReplicaForHandle(pushed, 'ws-1')?.keyId).toBe('A')

    const rotated = withReplicaEntry(pushed, 'ws-1', {
      daemonBaseUrl: 'http://d',
      ...pulledReplicaFields({ syncedAt: '2026-01-03T00:00:00Z', syncedFrontier: 'g', keyId: 'B' }),
    })
    expect(findReplicaForHandle(rotated, 'ws-1')?.keyId).toBe('B')
  })

  it('a pull that names no generation claims none', () => {
    expect(pulledReplicaFields({ syncedAt: 't', syncedFrontier: 'f' })).toEqual({
      syncedAt: 't',
      syncedFrontier: 'f',
    })
  })
})
