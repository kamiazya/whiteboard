import type { Kysely } from 'kysely'
import type { Migration } from 'kysely/migration'

// ADR-0029 retired the branch, and 0023 dropped its table; the lane label on
// a version row stayed because it still crossed the wire. Nothing reads it
// now, and every row held `main`.
//
// SQLite refuses to drop a column an index names, and
// `versions_document_branch_idx` spans `(documentId, branchName, createdAt)`,
// so the index goes first and is replaced by one over the two columns the
// history lookup still reads.
export const migration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropIndex('versions_document_branch_idx').execute()
    await db.schema.alterTable('versions').dropColumn('branchName').execute()
    await db.schema
      .createIndex('versions_document_idx')
      .on('versions')
      .columns(['documentId', 'createdAt'])
      .execute()
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropIndex('versions_document_idx').execute()
    await db.schema
      .alterTable('versions')
      .addColumn('branchName', 'text', (c) => c.notNull().defaultTo('main'))
      .execute()
    await db.schema
      .createIndex('versions_document_branch_idx')
      .on('versions')
      .columns(['documentId', 'branchName', 'createdAt'])
      .execute()
  },
}
