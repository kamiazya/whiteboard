import { Kysely, SqliteDialect, sql } from 'kysely'
import LibsqlNativeDatabase from 'libsql'
import { describe, expect, it } from 'vitest'
import type { DatabaseSchema } from '../schema.js'
import { migration as migration0004 } from './0004-workspace-index.js'
import { migration } from './0006-drop-workspace-index.js'

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
  'workspaceIndexDocumentList',
  'workspaceIndexFacets',
  'workspaceIndexAliases',
  'workspaceIndexBacklinks',
  'workspaceIndexAliasHistory',
]

const LOOKUP_INDEXES = [
  'workspaceIndexFacets_lookup',
  'workspaceIndexAliases_lookup',
  'workspaceIndexBacklinks_lookup',
  'workspaceIndexAliasHistory_lookup',
]

describe('0006-drop-workspace-index migration', () => {
  it('drops all five workspaceIndex* tables (and their lookup indexes) from a DB that ran 0004', async () => {
    const db = await createMemoryDb()
    try {
      await migration0004.up(db as unknown as Kysely<unknown>)
      for (const table of TABLES) {
        expect(await tableExists(db, table)).toBe(true)
      }

      await migration.up(db as unknown as Kysely<unknown>)

      for (const table of TABLES) {
        expect(await tableExists(db, table)).toBe(false)
      }
      for (const index of LOOKUP_INDEXES) {
        expect(await indexExists(db, index)).toBe(false)
      }
    } finally {
      await db.destroy()
    }
  })

  it('succeeds (no-op) on a DB that never ran 0004 — "drop table if exists"', async () => {
    const db = await createMemoryDb()
    try {
      await expect(migration.up(db as unknown as Kysely<unknown>)).resolves.toBeUndefined()
      for (const table of TABLES) {
        expect(await tableExists(db, table)).toBe(false)
      }
    } finally {
      await db.destroy()
    }
  })
})
