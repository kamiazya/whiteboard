import { Kysely, type MigrationProvider, Migrator, SqliteDialect, sql } from 'kysely'
import LibsqlNativeDatabase from 'libsql'
import { describe, expect, it } from 'vitest'
import type { DatabaseSchema } from '../schema.js'
import { migrations } from './index.js'

/** The migration this one renames on top of. */
const BEFORE = '0008-ulid-legacy-canvas-ids'
const THIS_ONE = '0009-document-vocabulary'

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

async function tableNames(db: Kysely<DatabaseSchema>): Promise<string[]> {
  const { rows } = await sql<{ name: string }>`
    select name from sqlite_master where type = 'table' order by name
  `.execute(db)
  return rows.map((r) => r.name)
}

async function indexNames(db: Kysely<DatabaseSchema>): Promise<string[]> {
  const { rows } = await sql<{ name: string }>`
    select name from sqlite_master where type = 'index' and name not like 'sqlite_%' order by name
  `.execute(db)
  return rows.map((r) => r.name)
}

describe('0009-document-vocabulary', () => {
  it('carries every row across the table and column renames', async () => {
    // The point of renaming rather than recreating: a database that already
    // holds documents must still hold them afterwards, with their branches
    // and versions still pointing at them.
    const db = await memoryDb()
    const migrator = migratorFor(db)
    expect((await migrator.migrateTo(BEFORE)).error).toBeUndefined()

    await sql`insert into workspaces (id, createdAt, updatedAt) values ('ws', 0, 0)`.execute(db)
    await sql`
      insert into canvases (id, workspaceId, slug, isPinned, currentBranch, createdAt, updatedAt)
      values ('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'ws', 'a-doc', 0, 'main', 0, 0)
    `.execute(db)
    await sql`
      insert into branches (canvasId, name, tipFrontiers, createdAt)
      values ('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'main', 'f', 0)
    `.execute(db)

    expect((await migrator.migrateTo(THIS_ONE)).error).toBeUndefined()

    const doc = await db.selectFrom('documents').selectAll().executeTakeFirstOrThrow()
    expect(doc.slug).toBe('a-doc')
    const branch = await db.selectFrom('branches').selectAll().executeTakeFirstOrThrow()
    expect(branch.documentId).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV')
    await db.destroy()
  })

  it('leaves no table or index still named for a canvas', async () => {
    // Stated over the WHOLE schema rather than per rename: a table this
    // migration forgot is exactly what a list of individual assertions would
    // not mention.
    const db = await memoryDb()
    expect((await migratorFor(db).migrateTo(THIS_ONE)).error).toBeUndefined()

    const named = [...(await tableNames(db)), ...(await indexNames(db))].filter((name) =>
      /canvas/i.test(name),
    )
    expect(named).toEqual([])
    await db.destroy()
  })

  it('keeps the foreign key from branches to documents', async () => {
    // SQLite carries a foreign key across `ALTER TABLE ... RENAME TO`, but
    // only with legacy_alter_table off. If that ever stopped holding, the
    // cascade would silently become a no-op and orphan rows would build up.
    const db = await memoryDb()
    expect((await migratorFor(db).migrateTo(THIS_ONE)).error).toBeUndefined()

    await sql`insert into workspaces (id, createdAt, updatedAt) values ('ws', 0, 0)`.execute(db)
    await sql`
      insert into documents (id, workspaceId, slug, isPinned, currentBranch, createdAt, updatedAt)
      values ('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'ws', 'a-doc', 0, 'main', 0, 0)
    `.execute(db)
    await sql`
      insert into branches (documentId, name, tipFrontiers, createdAt)
      values ('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'main', 'f', 0)
    `.execute(db)

    await expect(
      sql`
        insert into branches (documentId, name, tipFrontiers, createdAt)
        values ('01ARZ3NDEKTSV4RRFFQ69G5FAW', 'orphan', 'f', 0)
      `.execute(db),
    ).rejects.toThrow()

    await db.deleteFrom('documents').execute()
    expect(await db.selectFrom('branches').selectAll().execute()).toEqual([])
    await db.destroy()
  })

  it('down puts the old names back', async () => {
    const db = await memoryDb()
    const migrator = migratorFor(db)
    expect((await migrator.migrateTo(THIS_ONE)).error).toBeUndefined()
    expect((await migrator.migrateTo(BEFORE)).error).toBeUndefined()

    const tables = await tableNames(db)
    expect(tables).toContain('canvases')
    expect(tables).not.toContain('documents')
    expect(await indexNames(db)).toContain('versions_canvas_branch_idx')
    await db.destroy()
  })
})
