import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearWorkspaceIdCache, ensureWorkspaceId } from './current-workspace.js'
import { getDb } from './store/db/index.js'

describe('ensureWorkspaceId', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'whiteboard-ensure-test-'))
    clearWorkspaceIdCache()
  })

  afterEach(async () => {
    clearWorkspaceIdCache()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('memoizes the workspace id per dataDir so concurrent calls share one DB write', async () => {
    const ids = await Promise.all(Array.from({ length: 16 }, () => ensureWorkspaceId(dataDir)))
    const unique = new Set(ids)
    expect(unique.size).toBe(1)

    // The id is cached in-memory and persisted to the runtime table; calling
    // ensureWorkspaceId again must return the same value.
    const cached = ids[0]
    await expect(ensureWorkspaceId(dataDir)).resolves.toBe(cached)
  })

  it('returns the persisted id again after the in-memory cache is cleared', async () => {
    const first = await ensureWorkspaceId(dataDir)
    clearWorkspaceIdCache()
    await expect(ensureWorkspaceId(dataDir)).resolves.toBe(first)
  })

  it('keeps separate cache entries per dataDir', async () => {
    const otherDir = await mkdtemp(join(tmpdir(), 'whiteboard-ensure-test-other-'))
    try {
      const a = await ensureWorkspaceId(dataDir)
      const b = await ensureWorkspaceId(otherDir)
      expect(a).not.toBe(b)
      await expect(ensureWorkspaceId(dataDir)).resolves.toBe(a)
      await expect(ensureWorkspaceId(otherDir)).resolves.toBe(b)
    } finally {
      await rm(otherDir, { recursive: true, force: true })
    }
  })

  it('materializes the current workspace as a row, not only as a runtime marker', async () => {
    // The daemon commits to HAVING a current workspace the moment it resolves
    // one, but the workspaces table only ever learned about it as a side
    // effect of the first document write. Until then the daemon answered two
    // of its own questions inconsistently: it had a workspace id, and
    // `GET /api/workspaces` listed nothing — which is what left a browser
    // connected to a fresh daemon with no workspace to select.
    const id = await ensureWorkspaceId(dataDir)
    const db = await getDb(dataDir)
    const rows = await db.selectFrom('workspaces').select(['id']).execute()
    expect(rows.map((r) => r.id)).toEqual([id])
  })

  it('drops a failed promise from the cache so a subsequent call on THAT path can retry', async () => {
    // Treating a rejection as sticky would make every later call against the
    // same dataDir share the failed promise, so a data dir that becomes usable
    // could never be reached again in this process.
    //
    // Both halves must use the SAME path, because `ensureCache` is keyed by
    // dataDir: retrying a DIFFERENT path exercises a key that never had an
    // entry, and passes whether or not the cache is cleared. Measured — with
    // the eviction deleted, the earlier form of this test stayed green.
    //
    // A plain file standing where the directory should be is what makes the
    // first call fail, and it is reversible in-process. Permissions are not
    // usable here: the suite also runs as root, where `chmod 000` denies
    // nothing and the rejection never happens.
    const blocked = join(dataDir, 'occupied')
    await writeFile(blocked, 'not a directory')
    await expect(ensureWorkspaceId(blocked)).rejects.toBeDefined()

    await rm(blocked)
    await expect(ensureWorkspaceId(blocked)).resolves.toMatch(/^[A-Za-z0-9_-]{21}$/)
  })
})
