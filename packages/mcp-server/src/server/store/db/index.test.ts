import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Bench tests for the connection-cache + per-connection FK pragma. These were
// added after the initial cut of this PR shipped a stale-connection-cache /
// non-enforced-FK pair of bugs that the existing migration / store unit tests
// happily passed. Treat this as the canary suite for db/index.ts contracts.

let tempDir: string

vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
  DIST_APP_DIR: '/tmp/whiteboard/dist/app',
}))

const { getDb, closeDb, clearDbCache } = await import('./index.js')
const { prepareDataDir, clearPrepareCache } = await import('./prepare.js')

describe('getDb / closeDb', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-db-index-test-'))
    clearDbCache()
    clearPrepareCache()
  })

  afterEach(async () => {
    await closeDb(tempDir).catch(() => {})
    clearDbCache()
    clearPrepareCache()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('returns a single Database instance even when many concurrent callers race the cache', async () => {
    // The naive "store the resolved Database, not the pending promise" cache
    // would build N connections here and silently leak N-1 of them. Anchor
    // the behavior so future refactors of getDb keep the race-free contract.
    const dbs = await Promise.all(Array.from({ length: 32 }, () => getDb(tempDir)))
    const unique = new Set(dbs)
    expect(unique.size).toBe(1)
  })

  it('drops the cache entry when the build promise rejects so a later call can retry', async () => {
    const bogus = '/dev/null/cannot-make-a-dir-here'
    await expect(getDb(bogus)).rejects.toBeDefined()
    // Same key, second call: the failure must not be sticky.
    await expect(getDb(bogus)).rejects.toBeDefined()
    // And a healthy dir keeps working alongside the failed key.
    const ok = await getDb(tempDir)
    expect(ok).toBeDefined()
  })

  it('enforces foreign-key constraints on the connection used by the application', async () => {
    // The contract is "FK violations from the application throw". libsql's
    // current dialect happens to default `PRAGMA foreign_keys = ON`, but
    // vanilla SQLite does not. We deliberately assert the visible behavior
    // (orphan insert throws, cascade delete prunes children) rather than the
    // pragma value, so this test still flags any future regression — driver
    // swap, accidental pragma reset, or rebuilt schema without FK clauses.
    await prepareDataDir(tempDir)
    const db = await getDb(tempDir)

    // The branches table FKs canvases.id with ON DELETE CASCADE. Inserting a
    // branch row whose canvasId does not exist must throw, and deleting a
    // canvas must also delete its branches.
    const now = Date.now()
    await db
      .insertInto('workspaces')
      .values({ id: 'ws-fk', displayName: null, createdAt: now, updatedAt: now })
      .execute()
    await db
      .insertInto('canvases')
      .values({
        id: 'cv-fk',
        workspaceId: 'ws-fk',
        slug: 'main',
        displayName: null,
        isPinned: 0,
        pinOrder: null,
        currentBranch: 'main',
        createdAt: now,
        updatedAt: now,
      })
      .execute()
    await db
      .insertInto('branches')
      .values({
        canvasId: 'cv-fk',
        name: 'main',
        tipFrontiers: '',
        color: null,
        sourceBranchName: null,
        sourceVersionId: null,
        createdAt: now,
      })
      .execute()

    await expect(
      db
        .insertInto('branches')
        .values({
          canvasId: 'cv-does-not-exist',
          name: 'orphan',
          tipFrontiers: '',
          color: null,
          sourceBranchName: null,
          sourceVersionId: null,
          createdAt: now,
        })
        .execute(),
    ).rejects.toThrow(/FOREIGN KEY/i)

    await db.deleteFrom('canvases').where('id', '=', 'cv-fk').execute()
    const remaining = await db
      .selectFrom('branches')
      .selectAll()
      .where('canvasId', '=', 'cv-fk')
      .execute()
    expect(remaining).toEqual([])
  })
})
