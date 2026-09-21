/**
 * Pins the no-FK house style (0016/0017) and that the table does not exist
 * before this migration runs, and that the backfill marks exactly the
 * workspaces that already have a membership row. Mirrors
 * 0029-workspace-replica-keys.test.ts's shape.
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Kysely, SqliteDialect, sql } from 'kysely'
import { type MigrationProvider, Migrator } from 'kysely/migration'
import LibsqlNativeDatabase from 'libsql'
import { beforeEach, expect, it, vi } from 'vitest'
import { migrations } from './index.js'

let dataDir = ''
vi.mock('../../../config.js', () => ({
  get DATA_DIR() {
    return dataDir
  },
  getDataDir: () => dataDir,
}))

const PRE_0030 = '0029-workspace-replica-keys'

type Db = Kysely<Record<string, Record<string, unknown>>>

async function openDb(): Promise<{ db: Db; migrateTo(name: string): Promise<void> }> {
  const db: Db = new Kysely({
    dialect: new SqliteDialect({
      database: new LibsqlNativeDatabase(
        join(dataDir, 'whiteboard.db'),
      ) as unknown as ConstructorParameters<typeof SqliteDialect>[0]['database'],
    }),
  })
  await sql`PRAGMA foreign_keys = ON`.execute(db)
  const provider: MigrationProvider = { getMigrations: async () => migrations }
  const migrator = new Migrator({ db: db as never, provider })
  return {
    db,
    async migrateTo(name: string) {
      const { error } =
        name === 'head' ? await migrator.migrateToLatest() : await migrator.migrateTo(name)
      expect(error).toBeUndefined()
    },
  }
}

async function tableNames(db: Db): Promise<string[]> {
  const rows = await sql<{
    name: string
  }>`select name from sqlite_master where type = 'table'`.execute(db)
  return rows.rows.map((r) => r.name)
}

async function foreignKeysOf(db: Db, table: string): Promise<unknown[]> {
  const rows = await sql`select * from pragma_foreign_key_list('${sql.raw(table)}')`.execute(db)
  return rows.rows
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'workspace-members-only-'))
})

it('is absent before 0030, and backfills one row per distinct workspaceMemberships.workspaceId at head', async () => {
  const handle = await openDb()
  await handle.migrateTo(PRE_0030)
  const before = await tableNames(handle.db)
  expect(before).not.toContain('workspaceMembersOnly')

  // Seed pre-migration membership rows: ws-a has two, ws-b has none.
  await handle.db
    .insertInto('memberProfiles')
    .values([
      { id: 'p1', displayName: 'Ada', createdAt: 1, updatedAt: 1 },
      { id: 'p2', displayName: 'Bea', createdAt: 2, updatedAt: 2 },
    ])
    .execute()
  await handle.db
    .insertInto('workspaceMemberships')
    .values([
      { workspaceId: 'ws-a', profileId: 'p1', createdAt: 20 },
      { workspaceId: 'ws-a', profileId: 'p2', createdAt: 10 },
    ])
    .execute()

  await handle.migrateTo('head')

  const after = await tableNames(handle.db)
  expect(after).toContain('workspaceMembersOnly')
  expect(await foreignKeysOf(handle.db, 'workspaceMembersOnly')).toEqual([])

  const rows = await handle.db
    .selectFrom('workspaceMembersOnly')
    .selectAll()
    .orderBy('workspaceId', 'asc')
    .execute()
  expect(rows).toEqual([{ workspaceId: 'ws-a', since: 10 }])
})

it('leaves a workspace with no membership row unmarked at head', async () => {
  const handle = await openDb()
  await handle.migrateTo('head')

  const rows = await handle.db.selectFrom('workspaceMembersOnly').selectAll().execute()
  expect(rows).toEqual([])
})
