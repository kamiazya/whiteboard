import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
const { runMigrations } = await import('./migrator.js')
const { prepareDataDir, clearPrepareCache } = await import('./prepare.js')

describe('runMigrations', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-db-migrator-test-'))
    clearDbCache()
    clearPrepareCache()
  })

  afterEach(async () => {
    await closeDb(tempDir).catch(() => {})
    clearDbCache()
    clearPrepareCache()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('creates the database file and applies every migration on a fresh data dir', async () => {
    await prepareDataDir(tempDir)
    const db = await getDb(tempDir)
    await expect(stat(join(tempDir, 'whiteboard.db'))).resolves.toBeDefined()
    // Re-running is a no-op: kysely's __kysely_migration tracking table marks
    // every migration as applied so the second call returns silently.
    await expect(runMigrations(db)).resolves.toBeUndefined()
  })

  it('exposes the expected canvas + branches + versions schema after init', async () => {
    await prepareDataDir(tempDir)
    const db = await getDb(tempDir)
    await db
      .insertInto('workspaces')
      .values({ id: 'ws1', displayName: null, createdAt: 1, updatedAt: 1 })
      .execute()
    await db
      .insertInto('canvases')
      .values({
        id: 'cv1',
        workspaceId: 'ws1',
        slug: 'main',
        displayName: null,
        isPinned: 0,
        pinOrder: null,
        currentBranch: 'main',
        createdAt: 1,
        updatedAt: 1,
      })
      .execute()
    const row = await db
      .selectFrom('canvases')
      .select(['id', 'workspaceId', 'slug', 'currentBranch'])
      .where('id', '=', 'cv1')
      .executeTakeFirst()
    expect(row).toEqual({
      id: 'cv1',
      workspaceId: 'ws1',
      slug: 'main',
      currentBranch: 'main',
    })
  })
})
