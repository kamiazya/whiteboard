import { mkdtemp, rm } from 'node:fs/promises'
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

  it('drops a failed promise from the cache so a subsequent call can retry', async () => {
    // /dev/null cannot host a directory, so libsql will fail to open the .db
    // file under it and prepareDataDir rejects. Treating that rejection as
    // sticky would make every later call against a writable dir share the
    // failed promise; the cache must therefore be cleared on rejection.
    const bogus = '/dev/null/cannot-write-here'
    await expect(ensureWorkspaceId(bogus)).rejects.toBeDefined()
    await expect(ensureWorkspaceId(dataDir)).resolves.toMatch(/^[A-Za-z0-9_-]{21}$/)
  })
})
