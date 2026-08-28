import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Kysely, type MigrationProvider, Migrator, SqliteDialect, sql } from 'kysely'
import LibsqlNativeDatabase from 'libsql'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { migrations } from './index.js'

let dataDir = ''
vi.mock('../../../config.js', () => ({
  get DATA_DIR() {
    return dataDir
  },
  getDataDir: () => dataDir,
}))

const PRE_0018 = '0017-drop-documents-table'

interface Handle {
  db: Kysely<Record<string, Record<string, unknown>>>
  migrateTo(name: string): Promise<void>
  migrateToHead(): Promise<void>
}

async function openDb(): Promise<Handle> {
  const dbPath = join(dataDir, 'whiteboard.db')
  const db = new Kysely<Record<string, Record<string, unknown>>>({
    dialect: new SqliteDialect({
      database: new LibsqlNativeDatabase(dbPath) as unknown as ConstructorParameters<
        typeof SqliteDialect
      >[0]['database'],
    }),
  })
  await sql`PRAGMA foreign_keys = ON`.execute(db)
  const provider: MigrationProvider = { getMigrations: async () => migrations }
  const migrator = new Migrator({ db: db as never, provider })
  return {
    db,
    async migrateTo(name: string) {
      const { error } = await migrator.migrateTo(name)
      expect(error).toBeUndefined()
    },
    async migrateToHead() {
      const { error } = await migrator.migrateToLatest()
      expect(error).toBeUndefined()
    },
  }
}

async function columnNames(db: Handle['db'], table: string): Promise<string[]> {
  const rows = await sql<{ name: string }>`PRAGMA table_info(${sql.raw(table)})`.execute(db)
  return rows.rows.map((r) => r.name)
}

async function seedWorkspace(
  db: Handle['db'],
  id: string,
  segment: string | null = null,
): Promise<void> {
  const now = Date.now()
  // Pre-0018 rows have no `segment` column at all — insert without it, as a
  // pre-migration writer would have.
  await db
    .insertInto('workspaces')
    .values({ id, displayName: null, createdAt: now, updatedAt: now })
    .execute()
  if (segment !== null) {
    await db.updateTable('workspaces').set({ segment }).where('id', '=', id).execute()
  }
}

describe('0018-workspace-segment', () => {
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'migration-0018-'))
  })

  it('adds a nullable segment column, preserving pre-existing rows with segment NULL', async () => {
    const handle = await openDb()
    await handle.migrateTo(PRE_0018)
    await seedWorkspace(handle.db, 'ws-legacy')

    await handle.migrateToHead()

    expect(await columnNames(handle.db, 'workspaces')).toContain('segment')
    const row = await handle.db
      .selectFrom('workspaces')
      .select(['id', 'segment'])
      .where('id', '=', 'ws-legacy')
      .executeTakeFirst()
    expect(row).toEqual({ id: 'ws-legacy', segment: null })
  })

  it('rejects a duplicate non-NULL segment via the unique index', async () => {
    const handle = await openDb()
    await handle.migrateToHead()
    await seedWorkspace(handle.db, 'ws-a', 'team-notes')

    await expect(seedWorkspace(handle.db, 'ws-b', 'team-notes')).rejects.toThrow(
      /UNIQUE constraint failed/,
    )
  })

  it('allows multiple rows with a NULL segment to coexist', async () => {
    const handle = await openDb()
    await handle.migrateToHead()
    await seedWorkspace(handle.db, 'ws-a')
    await seedWorkspace(handle.db, 'ws-b')

    const rows = await handle.db
      .selectFrom('workspaces')
      .select(['id', 'segment'])
      .orderBy('id')
      .execute()
    expect(rows).toEqual([
      { id: 'ws-a', segment: null },
      { id: 'ws-b', segment: null },
    ])
  })
})
