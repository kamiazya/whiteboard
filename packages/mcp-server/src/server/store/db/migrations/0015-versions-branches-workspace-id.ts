import { type Kysely, type Migration, sql } from 'kysely'

// Re-key versions and branches on workspaceId (dual-plane collapse S3): every
// workspace-scoped query used to reach the workspaceId through an
// `innerJoin('documents')`, which is the version/branch tables' only
// remaining read dependency on the documents table. The column is backfilled
// from that same join, then written directly by every later insert.
//
// The documentId FK (migration 0001's ON DELETE CASCADE) is kept untouched —
// deleting a document must keep deleting its versions and branches, and an
// ADD COLUMN does not rebuild the table, so the constraint survives.
//
// versions.workspaceScoped is dropped, and the migration takes over the boot
// fold's sweep of workspaceScoped=0 rows on its way out: those frontiers
// point into per-document oplogs the fold already retired, so they can never
// be checked out again, and once the flag is gone nothing downstream could
// tell them apart. Deleting them here (before the drop) makes the state
// unrepresentable instead of corrupt-but-detectable.
export const migration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await sql`delete from versions where workspaceScoped = 0`.execute(db)
    await db.schema
      .alterTable('versions')
      .addColumn('workspaceId', 'text', (col) => col.notNull().defaultTo(''))
      .execute()
    await db.schema
      .alterTable('branches')
      .addColumn('workspaceId', 'text', (col) => col.notNull().defaultTo(''))
      .execute()
    await sql`
      update versions set workspaceId = (
        select documents.workspaceId from documents where documents.id = versions.documentId
      )
    `.execute(db)
    await sql`
      update branches set workspaceId = (
        select documents.workspaceId from documents where documents.id = branches.documentId
      )
    `.execute(db)
    await db.schema
      .createIndex('versions_workspace_id')
      .on('versions')
      .column('workspaceId')
      .execute()
    await db.schema
      .createIndex('branches_workspace_id')
      .on('branches')
      .column('workspaceId')
      .execute()
    await db.schema.alterTable('versions').dropColumn('workspaceScoped').execute()
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .alterTable('versions')
      .addColumn('workspaceScoped', 'integer', (col) => col.notNull().defaultTo(1))
      .execute()
    await db.schema.dropIndex('versions_workspace_id').execute()
    await db.schema.dropIndex('branches_workspace_id').execute()
    await db.schema.alterTable('versions').dropColumn('workspaceId').execute()
    await db.schema.alterTable('branches').dropColumn('workspaceId').execute()
  },
}
