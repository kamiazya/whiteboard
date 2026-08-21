import type { Kysely, Migration } from 'kysely'

// Backing store for ports' DocumentStore: a chunked full snapshot
// (header + ordered chunk rows) plus an append-only delta log, both keyed by
// docKey (the DocRef-derived string from ports' doc-ref-key.ts) so a canvas and
// the workspace-tree document never share rows even if their id strings
// collide. canvasDocFrontiers tracks "latest write wins" across snapshot
// saves and delta appends independently of either log's own row shape, since
// the two logs have no shared timestamp/sequence to compare against.

export const migration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .createTable('canvasDocSnapshots')
      .addColumn('docKey', 'text', (c) => c.primaryKey())
      .addColumn('chunkCount', 'integer', (c) => c.notNull())
      .addColumn('totalBytes', 'integer', (c) => c.notNull())
      .addColumn('maxChunkBytes', 'integer', (c) => c.notNull())
      .addColumn('frontier', 'blob', (c) => c.notNull())
      .execute()

    await db.schema
      .createTable('canvasDocSnapshotChunks')
      .addColumn('docKey', 'text', (c) =>
        c.notNull().references('canvasDocSnapshots.docKey').onDelete('cascade'),
      )
      .addColumn('chunkIndex', 'integer', (c) => c.notNull())
      .addColumn('bytes', 'blob', (c) => c.notNull())
      .addPrimaryKeyConstraint('canvasDocSnapshotChunks_pk', ['docKey', 'chunkIndex'])
      .execute()

    await db.schema
      .createTable('canvasDocDeltas')
      .addColumn('docKey', 'text', (c) => c.notNull())
      .addColumn('seq', 'integer', (c) => c.notNull())
      .addColumn('bytes', 'blob', (c) => c.notNull())
      .addColumn('frontier', 'blob', (c) => c.notNull())
      .addPrimaryKeyConstraint('canvasDocDeltas_pk', ['docKey', 'seq'])
      .execute()

    await db.schema
      .createTable('canvasDocFrontiers')
      .addColumn('docKey', 'text', (c) => c.primaryKey())
      .addColumn('frontier', 'blob', (c) => c.notNull())
      .execute()
  },

  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable('canvasDocFrontiers').execute()
    await db.schema.dropTable('canvasDocDeltas').execute()
    await db.schema.dropTable('canvasDocSnapshotChunks').execute()
    await db.schema.dropTable('canvasDocSnapshots').execute()
  },
}
