/**
 * Pins the no-FK house style (0016/0017) and that the table + column do not
 * exist before this migration runs. Mirrors 0028-member-profiles.test.ts's
 * shape.
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

const PRE_0029 = '0028-member-profiles'

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

async function columnNames(db: Db, table: string): Promise<string[]> {
  const rows = await sql<{
    name: string
  }>`select name from pragma_table_info('${sql.raw(table)}')`.execute(db)
  return rows.rows.map((r) => r.name)
}

async function foreignKeysOf(db: Db, table: string): Promise<unknown[]> {
  const rows = await sql`select * from pragma_foreign_key_list('${sql.raw(table)}')`.execute(db)
  return rows.rows
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'workspace-replica-keys-'))
})

it('creates workspaceReplicaKeys and workspaces.replicaTier, absent before and empty/present at head with no foreign keys', async () => {
  const handle = await openDb()
  await handle.migrateTo(PRE_0029)
  const before = await tableNames(handle.db)
  expect(before).not.toContain('workspaceReplicaKeys')
  expect(await columnNames(handle.db, 'workspaces')).not.toContain('replicaTier')

  await handle.migrateTo('head')

  const after = await tableNames(handle.db)
  expect(after).toContain('workspaceReplicaKeys')
  expect(await columnNames(handle.db, 'workspaces')).toContain('replicaTier')
  expect(await foreignKeysOf(handle.db, 'workspaceReplicaKeys')).toEqual([])
  const rows = await handle.db.selectFrom('workspaceReplicaKeys').selectAll().execute()
  expect(rows).toEqual([])
})
