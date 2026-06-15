import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Migrator } from 'kysely'
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
const { IncompatibleDatabaseError, isIncompatibleDatabaseError } = await import(
  './incompatible-database.js'
)
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

  // Forward-compat regression: the published mcp-server-v0.0.6 release shipped a
  // 0002-canvases-last-compacted-at migration, so databases created by it record that
  // name in the migration log. The current schema dropped that migration/feature; without
  // a no-op re-registration kysely would reject those DBs with
  // "corrupted migrations: previously executed migration 0002-canvases-last-compacted-at is missing".
  // Remove the no-op 0002 from migrations/index.ts and this test goes red (mutation check).
  it('migrates a v0.0.6-era DB whose log already records 0002-canvases-last-compacted-at', async () => {
    await prepareDataDir(tempDir)
    const db = await getDb(tempDir)

    // Reproduce a v0.0.6 database: migrate with a provider that includes the
    // 0002 name so kysely writes it into the migration log (its content is
    // irrelevant — the corrupted check is name-based), exactly as v0.0.6 would have.
    const { migrations } = await import('./migrations/index.js')
    const v006Migrator = new Migrator({
      db,
      provider: {
        getMigrations: async () => ({
          ...migrations,
          '0002-canvases-last-compacted-at': { up: async () => {}, down: async () => {} },
        }),
      },
    })
    const seed = await v006Migrator.migrateToLatest()
    expect(seed.error).toBeUndefined()

    // Current production migrator must not reject this DB as corrupted.
    await expect(runMigrations(db)).resolves.toBeUndefined()
  })

  // Graceful-failure: a DB whose migration log records a name the current code
  // does not ship (e.g. a newer release's migration, opened by an older build)
  // makes kysely throw a cryptic "corrupted migrations" error. runMigrations
  // must surface this as a typed, actionable IncompatibleDatabaseError that
  // points at the disposable-DB recovery docs — not the raw kysely message.
  it('throws an actionable IncompatibleDatabaseError when the DB log has an unknown migration', async () => {
    await prepareDataDir(tempDir)
    const db = await getDb(tempDir)

    // Seed a migration name the current provider does NOT know about, so the
    // current runMigrations sees an applied-but-missing migration = corrupted.
    const { migrations } = await import('./migrations/index.js')
    const futureMigrator = new Migrator({
      db,
      provider: {
        getMigrations: async () => ({
          ...migrations,
          '9999-from-a-newer-release': { up: async () => {}, down: async () => {} },
        }),
      },
    })
    const seed = await futureMigrator.migrateToLatest()
    expect(seed.error).toBeUndefined()

    await expect(runMigrations(db)).rejects.toThrow(IncompatibleDatabaseError)
    // The message must be actionable: name the recovery path, not kysely internals.
    await expect(runMigrations(db)).rejects.toThrow(/whiteboard\.db|re-create|mcp-debugging/)
    // The typed guard recognizes it.
    const err = await runMigrations(db).catch((e: unknown) => e)
    expect(isIncompatibleDatabaseError(err)).toBe(true)
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
