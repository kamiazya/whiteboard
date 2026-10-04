import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'kysely'
import { Migrator } from 'kysely/migration'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CAN_DENY_FILE_READ } from '../../../shared/test-utils/can-deny-file-read.js'

let tempDir: string

vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { getDb, getRawDb, closeDb, clearDbCacheForTests } = await import('./index.js')
const { runMigrations } = await import('./migrator.js')
const { IncompatibleDatabaseError } = await import('./incompatible-database.js')
const { prepareDataDir, clearPrepareCache } = await import('./prepare.js')

describe('runMigrations', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-db-migrator-test-'))
    clearDbCacheForTests()
    clearPrepareCache()
  })

  afterEach(async () => {
    await closeDb(tempDir).catch(() => {})
    clearDbCacheForTests()
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

  // Inserted directly: kysely's own Migrator refuses to record a name that
  // sorts before one already executed, and a renamed migration is exactly that.
  async function seedUnknownMigration(name: string) {
    const db = await getRawDb(tempDir)
    await sql`insert into kysely_migration (name, timestamp) values (${name}, ${new Date().toISOString()})`.execute(
      db,
    )
    return db
  }

  // A DB whose migration log records a name AFTER the last one this build
  // ships was written by a newer release. The remedy is to upgrade the older
  // build; deleting the database would destroy documents that a newer build
  // reads fine.
  it('tells an older build to upgrade, never to delete, when the database records a newer migration', async () => {
    await prepareDataDir(tempDir)
    const db = await seedUnknownMigration('0099-from-a-newer-release')

    const err = await runMigrations(db, '/srv/wb-data/whiteboard.db').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(IncompatibleDatabaseError)
    const message = (err as Error).message
    expect(message).toMatch(/newer/i)
    expect(message).toMatch(/upgrade/i)
    expect(message).toContain('@kamiazya/whiteboard-mcp')
    expect(message).toContain('0099-from-a-newer-release')
    expect(message).toContain('/srv/wb-data/whiteboard.db')
    expect(message).not.toMatch(/remov|delet|re-create|disposable/i)
    expect(message).not.toContain('~/.whiteboard')
  })

  // A name in the middle of the published list is a renamed or dropped
  // migration: nothing newer would read this database, so re-creating it is the
  // documented pre-1.0 remedy, and it must name the database actually in use.
  it('names the real database when a published-range migration is missing from this build', async () => {
    await prepareDataDir(tempDir)
    const db = await seedUnknownMigration('0005-renamed-in-a-later-release')

    const err = await runMigrations(db, '/srv/wb-data/whiteboard.db').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(IncompatibleDatabaseError)
    const message = (err as Error).message
    expect(message).toContain('0005-renamed-in-a-later-release')
    expect(message).toContain('/srv/wb-data/whiteboard.db')
    expect(message).toMatch(/re-create/i)
    expect(message).not.toContain('~/.whiteboard')
    expect(message).not.toMatch(/upgrade/i)
  })

  it('prepareDataDir names the data dir database in the incompatibility message', async () => {
    await prepareDataDir(tempDir)
    await seedUnknownMigration('0099-from-a-newer-release')
    clearPrepareCache()
    const err = await prepareDataDir(tempDir).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(IncompatibleDatabaseError)
    expect((err as Error).message).toContain(join(tempDir, 'whiteboard.db'))
  })

  // 0011-import-fs-blobs walks {dataDir}/blobs/<workspaceId>/canvas — an
  // unreadable canvas directory (permissions changed on the data dir, a
  // restrictive umask) rethrows out of the migration with a raw Node
  // errno error. runMigrations must reframe it the same way it reframes
  // the corrupted-migrations case, instead of surfacing the bare
  // "EACCES ... scandir '<path>'" message with no recovery guidance.
  // Skipped where this process cannot be denied read access to its own
  // files -- root, or a filesystem that ignores the mode. `shared/test-utils/can-deny-file-read.ts`
  // PROBES that rather than inferring it from the uid, and says why.
  it.skipIf(!CAN_DENY_FILE_READ)(
    'reframes an EACCES readdir failure during migration into an actionable message',
    async () => {
      const canvasDir = join(tempDir, 'blobs', 'ws-1', 'canvas')
      await mkdir(canvasDir, { recursive: true })
      await writeFile(join(canvasDir, 'doc-a.loro'), 'irrelevant')
      await chmod(canvasDir, 0o000)

      try {
        const db = await getDb(tempDir)
        await expect(runMigrations(db)).rejects.toThrow(/permission|blobs/i)
        const err = await runMigrations(db).catch((e: unknown) => e)
        expect((err as { cause?: unknown }).cause).toMatchObject({ code: 'EACCES' })
      } finally {
        await chmod(canvasDir, 0o755)
      }
    },
  )

  it('exposes the expected workspaces + versions schema after init, with no documents row required (0016/0017)', async () => {
    await prepareDataDir(tempDir)
    const db = await getDb(tempDir)
    await db
      .insertInto('workspaces')
      .values({ id: 'ws1', displayName: null, createdAt: 1, updatedAt: 1 })
      .execute()
    // No documents row: migration 0016 dropped its FK from versions and 0017
    // dropped the table outright, so a tree-only document's rows must insert
    // cleanly on their own. (Branch rows were the other half of this until
    // 0023 dropped that table.)
    await db
      .insertInto('versions')
      .values({
        id: 'v1',
        documentId: 'cv1',
        workspaceId: 'ws1',
        auto: 1,
        label: null,
        operatorKind: 'system',
        operatorActor: '',
        operatorDisplayName: null,
        operatorAgentId: null,
        operatorWorkspaceId: null,
        elementCount: 0,
        frontiers: '',
        contentDigest: '',
        createdAt: 1,
      })
      .execute()
    const row = await db
      .selectFrom('versions')
      .select(['id', 'documentId', 'workspaceId'])
      .where('documentId', '=', 'cv1')
      .executeTakeFirst()
    expect(row).toEqual({ id: 'v1', documentId: 'cv1', workspaceId: 'ws1' })
  })
})
