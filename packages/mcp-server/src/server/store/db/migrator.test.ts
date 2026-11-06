import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'kysely'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RETIRED_MIGRATION_NAMES } from './published-migration-names.js'

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
  // reads fine. In a source checkout the newer side is usually the checkout's
  // own unreleased migration, which no published release ships yet, so the
  // message names the rebuild as well.
  it('tells an older build to upgrade, never to delete, when the database records a newer migration', async () => {
    await prepareDataDir(tempDir)
    const db = await seedUnknownMigration('0099-from-a-newer-release')

    const err = await runMigrations(db, '/srv/wb-data/whiteboard.db').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(IncompatibleDatabaseError)
    const message = (err as Error).message
    expect(message).toMatch(/newer/i)
    expect(message).toMatch(/upgrade/i)
    expect(message).toContain('@kamiazya/whiteboard-mcp')
    expect(message).toContain('pnpm build')
    expect(message).toContain('0099-from-a-newer-release')
    expect(message).toContain('/srv/wb-data/whiteboard.db')
    expect(message).not.toMatch(/remov|delet|re-create|disposable/i)
    expect(message).not.toContain('~/.whiteboard')
  })

  // A name inside the published range is a renamed or dropped migration:
  // nothing newer would read this database, so re-creating it is the
  // documented pre-1.0 remedy, and it must name the database actually in use.
  it('names the real database when a published-range migration is missing from this build', async () => {
    await prepareDataDir(tempDir)
    const db = await seedUnknownMigration('0001-a-renamed-baseline')

    const err = await runMigrations(db, '/srv/wb-data/whiteboard.db').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(IncompatibleDatabaseError)
    const message = (err as Error).message
    expect(message).toContain('0001-a-renamed-baseline')
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

  // A database written before the schema was reset to one baseline records
  // the retired history, and this build reads none of it. The refusal must
  // happen before the baseline runs on top of it, and must say how to carry
  // the documents across, since re-creating the database alone loses them.
  it('refuses a database at the retired migration history, naming the export and re-import path', async () => {
    const db = await getRawDb(tempDir)
    await sql`create table kysely_migration (name varchar(255) not null primary key, timestamp varchar(255) not null)`.execute(
      db,
    )
    for (const name of RETIRED_MIGRATION_NAMES) {
      await sql`insert into kysely_migration (name, timestamp) values (${name}, ${new Date().toISOString()})`.execute(
        db,
      )
    }

    const err = await prepareDataDir(tempDir).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(IncompatibleDatabaseError)
    const message = (err as Error).message
    expect(message).toContain(join(tempDir, 'whiteboard.db'))
    expect(message).toContain('earlier release')
    expect(message).toContain('Export')
    expect(message).toContain('Save as JSON Canvas')
    expect(message).toContain('Import file')
    expect(message).toContain('fresh data directory')
    expect(message).not.toMatch(/newer release|renamed/i)
    const { rows } = await sql<{ name: string }>`
      select name from sqlite_master where type = 'table' and name not like 'kysely_%'
    `.execute(db)
    expect(rows).toEqual([])
  })

  it('stores a version row with no document row beside it', async () => {
    await prepareDataDir(tempDir)
    const db = await getDb(tempDir)
    await db
      .insertInto('workspaces')
      .values({ id: 'ws1', displayName: null, createdAt: 1, updatedAt: 1 })
      .execute()
    // A document lives in the workspace tree, not in a table, so its version
    // rows reference nothing the database could hold a key to.
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
