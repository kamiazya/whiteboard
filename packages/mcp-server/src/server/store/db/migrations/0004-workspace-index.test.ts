import { Kysely, SqliteDialect, sql } from 'kysely'
import LibsqlNativeDatabase from 'libsql'
import { describe, expect, it } from 'vitest'
import type { DatabaseSchema } from '../schema.js'
import { migration } from './0004-workspace-index.js'

async function createMemoryDb(): Promise<Kysely<DatabaseSchema>> {
  const db = new Kysely<DatabaseSchema>({
    dialect: new SqliteDialect({
      database: new LibsqlNativeDatabase(':memory:') as unknown as ConstructorParameters<
        typeof SqliteDialect
      >[0]['database'],
    }),
  })
  await sql`PRAGMA foreign_keys = ON`.execute(db)
  return db
}

async function tableExists(db: Kysely<DatabaseSchema>, name: string): Promise<boolean> {
  const row = await sql<{
    name: string
  }>`select name from sqlite_master where type = 'table' and name = ${name}`.execute(db)
  return row.rows.length > 0
}

async function indexExists(db: Kysely<DatabaseSchema>, name: string): Promise<boolean> {
  const row = await sql<{
    name: string
  }>`select name from sqlite_master where type = 'index' and name = ${name}`.execute(db)
  return row.rows.length > 0
}

const TABLES = [
  'workspaceIndexCanvasList',
  'workspaceIndexFacets',
  'workspaceIndexAliases',
  'workspaceIndexBacklinks',
  'workspaceIndexAliasHistory',
]

// One lookup index per workspace-scoped table that queryFacet/listBacklinks/
// alias resolution rely on for non-scan lookups (workspaceIndexCanvasList has
// no dedicated lookup index — it is read in full per workspace).
const LOOKUP_INDEXES = [
  'workspaceIndexFacets_lookup',
  'workspaceIndexAliases_lookup',
  'workspaceIndexBacklinks_lookup',
  'workspaceIndexAliasHistory_lookup',
]

describe('0004-workspace-index migration', () => {
  it('up creates all five tables and their lookup indexes; down drops the tables', async () => {
    const db = await createMemoryDb()
    try {
      await migration.up(db as unknown as Kysely<unknown>)

      for (const table of TABLES) {
        expect(await tableExists(db, table)).toBe(true)
      }
      for (const index of LOOKUP_INDEXES) {
        expect(await indexExists(db, index)).toBe(true)
      }

      await migration.down(db as unknown as Kysely<unknown>)

      for (const table of TABLES) {
        expect(await tableExists(db, table)).toBe(false)
      }
    } finally {
      await db.destroy()
    }
  })
})
