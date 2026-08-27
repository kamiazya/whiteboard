import { type Kysely, type Migration, sql } from 'kysely'

// The documents table stops being the address book (dual-plane collapse S7):
// after the wrapper retirement a document created through the workspace tree
// has no row at all, so a versions/branches insert must not require one.
// Both tables are rebuilt without migration 0001's documents FK — an ALTER
// cannot drop a constraint in SQLite — and delete-completeness moves from
// the cascade into the delete path's own explicit cleanup (documentTeardown
// and deleteDocument delete by documentId).
export const migration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .createTable('versions_next')
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('documentId', 'text', (c) => c.notNull())
      .addColumn('workspaceId', 'text', (c) => c.notNull().defaultTo(''))
      .addColumn('branchName', 'text', (c) => c.notNull().defaultTo('main'))
      .addColumn('auto', 'integer', (c) => c.notNull().defaultTo(0))
      .addColumn('label', 'text')
      .addColumn('operatorKind', 'text', (c) => c.notNull())
      .addColumn('operatorPeerId', 'text', (c) => c.notNull())
      .addColumn('operatorDisplayName', 'text')
      .addColumn('operatorAgentId', 'text')
      .addColumn('operatorWorkspaceId', 'text')
      .addColumn('elementCount', 'integer', (c) => c.notNull().defaultTo(0))
      .addColumn('frontiers', 'text', (c) => c.notNull())
      .addColumn('hasThumbnail', 'integer', (c) => c.notNull().defaultTo(0))
      .addColumn('createdAt', 'integer', (c) => c.notNull())
      .execute()
    await sql`insert into versions_next select id, documentId, workspaceId, branchName, auto, label, operatorKind, operatorPeerId, operatorDisplayName, operatorAgentId, operatorWorkspaceId, elementCount, frontiers, hasThumbnail, createdAt from versions`.execute(
      db,
    )
    await db.schema.dropTable('versions').execute()
    await sql`alter table versions_next rename to versions`.execute(db)
    await db.schema
      .createIndex('versions_document_branch_idx')
      .on('versions')
      .columns(['documentId', 'branchName', 'createdAt'])
      .execute()
    await db.schema
      .createIndex('versions_workspace_id')
      .on('versions')
      .column('workspaceId')
      .execute()

    await db.schema
      .createTable('branches_next')
      .addColumn('documentId', 'text', (c) => c.notNull())
      .addColumn('workspaceId', 'text', (c) => c.notNull().defaultTo(''))
      .addColumn('name', 'text', (c) => c.notNull())
      .addColumn('tipFrontiers', 'text', (c) => c.notNull())
      .addColumn('color', 'text')
      .addColumn('sourceBranchName', 'text')
      .addColumn('sourceVersionId', 'text')
      .addColumn('createdAt', 'integer', (c) => c.notNull())
      .addPrimaryKeyConstraint('branches_pk', ['documentId', 'name'])
      .execute()
    await sql`insert into branches_next select documentId, workspaceId, name, tipFrontiers, color, sourceBranchName, sourceVersionId, createdAt from branches`.execute(
      db,
    )
    await db.schema.dropTable('branches').execute()
    await sql`alter table branches_next rename to branches`.execute(db)
    await db.schema
      .createIndex('branches_workspace_id')
      .on('branches')
      .column('workspaceId')
      .execute()
  },
  async down(): Promise<void> {
    // The FK is not restorable without re-inventing rows for tree-only
    // documents; pre-1.0 disposable-DB policy applies.
    throw new Error('0016-drop-documents-fk cannot be rolled back')
  },
}
