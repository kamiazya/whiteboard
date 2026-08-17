import type { Kysely, Migration } from 'kysely'

// ADR-0009 decision 1: a workspace contains Documents, and `Canvas` narrows
// to the spatial surface. The schema was the last layer still using the old
// container noun — `canvases` for the documents table, `canvasId` for a
// document id, `canvasDoc*` for the four Loro-storage tables.
//
// Renames rather than recreates: SQLite's ALTER TABLE ... RENAME TO carries
// foreign keys and indexes with it, so every row and reference survives. The
// index NAMES do not follow, and are the one thing that has to be dropped and
// recreated to stop saying `canvases` / `canvas`.
//
// Constraint names (e.g. `canvasDocSnapshotChunks_pk`) are deliberately left
// alone: SQLite cannot rename one without rebuilding the table, and they
// appear nowhere outside `sqlite_master` — no reader of this codebase can see
// them, so they cost the vocabulary nothing.
//
// Note for anyone editing this file with a project-wide rename: every table
// and column named here is the name AS IT EXISTS AT THIS POINT IN THE LOG.
// A migration is history, so both sides of each rename below are literals
// that must never move again.
export const migration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema.alterTable('canvases').renameTo('documents').execute()
    await db.schema.alterTable('branches').renameColumn('canvasId', 'documentId').execute()
    await db.schema.alterTable('versions').renameColumn('canvasId', 'documentId').execute()
    await db.schema.alterTable('canvasDocSnapshots').renameTo('documentSnapshots').execute()
    await db.schema
      .alterTable('canvasDocSnapshotChunks')
      .renameTo('documentSnapshotChunks')
      .execute()
    await db.schema.alterTable('canvasDocDeltas').renameTo('documentDeltas').execute()
    await db.schema.alterTable('canvasDocFrontiers').renameTo('documentFrontiers').execute()

    await db.schema.dropIndex('canvases_workspace_updated_idx').ifExists().execute()
    await db.schema
      .createIndex('documents_workspace_updated_idx')
      .on('documents')
      .columns(['workspaceId', 'updatedAt'])
      .execute()
    await db.schema.dropIndex('versions_canvas_branch_idx').ifExists().execute()
    await db.schema
      .createIndex('versions_document_branch_idx')
      .on('versions')
      .columns(['documentId', 'branchName', 'createdAt'])
      .execute()
  },

  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropIndex('versions_document_branch_idx').ifExists().execute()
    await db.schema.dropIndex('documents_workspace_updated_idx').ifExists().execute()
    await db.schema.alterTable('documentFrontiers').renameTo('canvasDocFrontiers').execute()
    await db.schema.alterTable('documentDeltas').renameTo('canvasDocDeltas').execute()
    await db.schema
      .alterTable('documentSnapshotChunks')
      .renameTo('canvasDocSnapshotChunks')
      .execute()
    await db.schema.alterTable('documentSnapshots').renameTo('canvasDocSnapshots').execute()
    await db.schema.alterTable('versions').renameColumn('documentId', 'canvasId').execute()
    await db.schema.alterTable('branches').renameColumn('documentId', 'canvasId').execute()
    await db.schema.alterTable('documents').renameTo('canvases').execute()
    await db.schema
      .createIndex('canvases_workspace_updated_idx')
      .on('canvases')
      .columns(['workspaceId', 'updatedAt'])
      .execute()
    await db.schema
      .createIndex('versions_canvas_branch_idx')
      .on('versions')
      .columns(['canvasId', 'branchName', 'createdAt'])
      .execute()
  },
}
