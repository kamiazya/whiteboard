/**
 * A bracket over the workspace record holds it: the record a `withRecord`
 * reads is not given back while the bracket is running, however the cache has
 * treated its entry meanwhile, and is given back once the bracket has ended
 * and the entry has gone. The loan is watched through the cache's own release.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { workspaceIdFor } from '@kamiazya/whiteboard-model/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let tempDir: string
vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const {
  withWorkspaceRecord,
  withStoredWorkspaceRecord,
  withPersistedWorkspaceRecord,
  evictWorkspaceDocCache,
  _clearWorkspaceDocCacheForTests,
  _workspaceRecordReleasesForTests,
  workspaceDocCacheMaxEntries,
  _workspaceRecordLoansForTests,
} = await import('./workspace-doc-cache.js')
const { RecordCache } = await import('./record-cache.js')
const { WORKSPACE_RECORD_KIND } = await import('./workspace-record-kind.js')
const { globalStoreScope } = await import('./store-scope.js')
const { createIsolatedDb } = await import('./db/test-helpers.js')

let handle: Awaited<ReturnType<typeof createIsolatedDb>>
const ws = (i: number) => workspaceIdFor(`ws-lend-${i}`)

/** Opens the record into the cache and gives the loan back. */
const warm = (workspaceId: string) =>
  withWorkspaceRecord(workspaceId, globalStoreScope, async () => {})

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'ws-doc-lend-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
  _clearWorkspaceDocCacheForTests()
})
afterEach(async () => {
  _clearWorkspaceDocCacheForTests()
  await handle.dispose()
  await rm(tempDir, { recursive: true, force: true })
})

describe('a bracket over the workspace record', () => {
  it('holds the record past the entry it was lent from, and gives it back when it ends', async () => {
    const releases = _workspaceRecordReleasesForTests()
    await warm(ws(0))
    releases.length = 0

    await withWorkspaceRecord(ws(0), globalStoreScope, async () => {
      evictWorkspaceDocCache(ws(0), globalStoreScope)
      expect(releases).toEqual([])
    })

    expect(releases).toHaveLength(1)
  })

  it('does the same for a bracket that reads only a stored record', async () => {
    const releases = _workspaceRecordReleasesForTests()
    await warm(ws(0))
    releases.length = 0

    await withStoredWorkspaceRecord(ws(0), globalStoreScope, async () => {
      evictWorkspaceDocCache(ws(0), globalStoreScope)
      expect(releases).toEqual([])
    })

    expect(releases).toHaveLength(1)
  })

  it('does the same for a bracket over the persisted record', async () => {
    const releases = _workspaceRecordReleasesForTests()
    await warm(ws(0))
    releases.length = 0

    await withPersistedWorkspaceRecord(ws(0), globalStoreScope, async () => {
      evictWorkspaceDocCache(ws(0), globalStoreScope)
      expect(releases).toEqual([])
    })

    expect(releases).toHaveLength(1)
  })

  it('gives the record back when the bracket throws', async () => {
    const releases = _workspaceRecordReleasesForTests()
    await warm(ws(0))
    releases.length = 0

    await expect(
      withWorkspaceRecord(ws(0), globalStoreScope, async () => {
        evictWorkspaceDocCache(ws(0), globalStoreScope)
        throw new Error('refused')
      }),
    ).rejects.toThrow('refused')

    expect(releases).toHaveLength(1)
  })

  it('does not release a record that stays in the cache', async () => {
    const releases = _workspaceRecordReleasesForTests()
    await withWorkspaceRecord(ws(0), globalStoreScope, async () => {})
    expect(releases).toEqual([])
  })

  it('releases a record the bound drops, once no bracket reads it', async () => {
    const releases = _workspaceRecordReleasesForTests()
    for (let i = 0; i <= workspaceDocCacheMaxEntries(); i++) await warm(ws(i))
    expect(releases).toHaveLength(1)
  })

  it('gives back the loan it took of a record another cold open kept in its place', async () => {
    await warm(ws(0))
    _clearWorkspaceDocCacheForTests()
    // A second cold open's keep lands between this one's keep and its acquire.
    const other = await WORKSPACE_RECORD_KIND.index.empty()
    const keep = RecordCache.prototype.keep
    let interleaved = false
    const spy = vi.spyOn(RecordCache.prototype, 'keep').mockImplementation(function (
      this: InstanceType<typeof RecordCache>,
      key: string,
      workspaceId: string,
      held: object,
    ) {
      keep.call(this, key, workspaceId, held)
      if (interleaved) return
      interleaved = true
      keep.call(this, key, workspaceId, other)
    })

    try {
      await withStoredWorkspaceRecord(ws(0), globalStoreScope, async () => {})
    } finally {
      spy.mockRestore()
    }

    expect(interleaved).toBe(true)
    expect(_workspaceRecordLoansForTests()).toBe(0)
  })
})
