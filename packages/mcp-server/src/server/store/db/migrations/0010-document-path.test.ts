import { Kysely, type MigrationProvider, Migrator, SqliteDialect, sql } from 'kysely'
import LibsqlNativeDatabase from 'libsql'
import { describe, expect, it } from 'vitest'
import type { DatabaseSchema } from '../schema.js'
import { migrations } from './index.js'

const BEFORE = '0009-document-vocabulary'
const THIS_ONE = '0010-document-path'

async function memoryDb(): Promise<Kysely<DatabaseSchema>> {
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

function migratorFor(db: Kysely<DatabaseSchema>): Migrator {
  const provider: MigrationProvider = { getMigrations: async () => migrations }
  return new Migrator({ db: db as never, provider })
}

async function seedDocument(db: Kysely<DatabaseSchema>, column: 'slug' | 'path'): Promise<void> {
  await sql`insert into workspaces (id, createdAt, updatedAt) values ('ws', 0, 0)`.execute(db)
  await sql`
    insert into documents (id, workspaceId, ${sql.ref(column)}, isPinned, currentBranch, createdAt, updatedAt)
    values ('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'ws', 'notes/weekly', 0, 'main', 0, 0)
  `.execute(db)
}

describe('0010-document-path', () => {
  it('carries the stored path across the rename', async () => {
    const db = await memoryDb()
    const migrator = migratorFor(db)
    expect((await migrator.migrateTo(BEFORE)).error).toBeUndefined()
    await seedDocument(db, 'slug')

    expect((await migrator.migrateTo(THIS_ONE)).error).toBeUndefined()

    const doc = await db.selectFrom('documents').selectAll().executeTakeFirstOrThrow()
    expect(doc.path).toBe('notes/weekly')
    await db.destroy()
  })

  it('keeps the path unique per workspace', async () => {
    // The `(workspaceId, slug)` unique constraint has to follow the column
    // rename. If it did not, two documents could claim one path and
    // `DocumentPathTakenError` would stop being reachable from the store.
    const db = await memoryDb()
    expect((await migratorFor(db).migrateTo(THIS_ONE)).error).toBeUndefined()
    await seedDocument(db, 'path')

    await expect(
      sql`
        insert into documents (id, workspaceId, path, isPinned, currentBranch, createdAt, updatedAt)
        values ('01ARZ3NDEKTSV4RRFFQ69G5FAW', 'ws', 'notes/weekly', 0, 'main', 0, 0)
      `.execute(db),
    ).rejects.toThrow()
    await db.destroy()
  })

  it('leaves no column named slug', async () => {
    const db = await memoryDb()
    expect((await migratorFor(db).migrateTo(THIS_ONE)).error).toBeUndefined()

    const { rows } = await sql<{ name: string }>`
      select name from pragma_table_info('documents')
    `.execute(db)
    expect(rows.map((r) => r.name)).toContain('path')
    expect(rows.map((r) => r.name)).not.toContain('slug')
    await db.destroy()
  })

  it('down puts the old name back', async () => {
    const db = await memoryDb()
    const migrator = migratorFor(db)
    expect((await migrator.migrateTo(THIS_ONE)).error).toBeUndefined()
    expect((await migrator.migrateTo(BEFORE)).error).toBeUndefined()

    const { rows } = await sql<{ name: string }>`
      select name from pragma_table_info('documents')
    `.execute(db)
    expect(rows.map((r) => r.name)).toContain('slug')
    await db.destroy()
  })
})
