import { Kysely, SqliteDialect, sql } from 'kysely'
import LibsqlNativeDatabase from 'libsql'
import { describe, expect, it } from 'vitest'
import type { DatabaseSchema } from '../schema.js'
import { migration as initMigration } from './0001-init.js'
import { migration } from './0005-canvases-kind.js'

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

async function hasColumn(db: Kysely<DatabaseSchema>, table: string, column: string) {
  const row = await sql<{ name: string }>`select name from pragma_table_info(${table})`.execute(db)
  return row.rows.some((r) => r.name === column)
}

describe('0005-canvases-kind migration', () => {
  it('up adds the canvases.kind column; down drops it', async () => {
    const db = await createMemoryDb()
    try {
      // canvases only exists once 0001-init has run — this migration alters
      // an existing table rather than creating one.
      await initMigration.up(db as unknown as Kysely<unknown>)
      expect(await hasColumn(db, 'canvases', 'kind')).toBe(false)

      await migration.up(db as unknown as Kysely<unknown>)
      expect(await hasColumn(db, 'canvases', 'kind')).toBe(true)

      await migration.down(db as unknown as Kysely<unknown>)
      expect(await hasColumn(db, 'canvases', 'kind')).toBe(false)
    } finally {
      await db.destroy()
    }
  })
})
