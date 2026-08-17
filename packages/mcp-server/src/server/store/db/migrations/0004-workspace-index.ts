import type { Kysely, Migration } from 'kysely'

// Backing store for ports' WorkspaceIndex: five workspace-scoped
// tables (canvas list, facets, aliases, backlinks, alias history), each
// carrying `workspaceId` as its isolation key so one index can safely back
// many workspaces (see ports' WorkspaceIndex doc comment).
//
// `seq` records each row's position within the array the owning `applyRows`
// call received for that table. InMemoryWorkspaceIndex's read methods
// (`.find()`, `.filter()`) return results in that same array order, so every
// query here orders by `seq asc` to stay observationally identical to it —
// this is what the parity test asserts.
export const migration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .createTable('workspaceIndexDocumentList')
      .addColumn('workspaceId', 'text', (c) => c.notNull())
      .addColumn('seq', 'integer', (c) => c.notNull())
      .addColumn('canvasId', 'text', (c) => c.notNull())
      .addColumn('title', 'text', (c) => c.notNull())
      .addColumn('updatedAtMs', 'integer', (c) => c.notNull())
      .addPrimaryKeyConstraint('workspaceIndexDocumentList_pk', ['workspaceId', 'seq'])
      .execute()

    await db.schema
      .createTable('workspaceIndexFacets')
      .addColumn('workspaceId', 'text', (c) => c.notNull())
      .addColumn('seq', 'integer', (c) => c.notNull())
      .addColumn('facet', 'text', (c) => c.notNull())
      .addColumn('value', 'text', (c) => c.notNull())
      .addColumn('canvasId', 'text', (c) => c.notNull())
      .addPrimaryKeyConstraint('workspaceIndexFacets_pk', ['workspaceId', 'seq'])
      .execute()
    // Backs queryFacet's exact (workspaceId, facet, value) lookup — without
    // this the query degrades to a full table scan per call.
    await db.schema
      .createIndex('workspaceIndexFacets_lookup')
      .on('workspaceIndexFacets')
      .columns(['workspaceId', 'facet', 'value'])
      .execute()

    await db.schema
      .createTable('workspaceIndexAliases')
      .addColumn('workspaceId', 'text', (c) => c.notNull())
      .addColumn('seq', 'integer', (c) => c.notNull())
      .addColumn('alias', 'text', (c) => c.notNull())
      .addColumn('canvasId', 'text', (c) => c.notNull())
      .addPrimaryKeyConstraint('workspaceIndexAliases_pk', ['workspaceId', 'seq'])
      .execute()
    await db.schema
      .createIndex('workspaceIndexAliases_lookup')
      .on('workspaceIndexAliases')
      .columns(['workspaceId', 'alias'])
      .execute()

    await db.schema
      .createTable('workspaceIndexBacklinks')
      .addColumn('workspaceId', 'text', (c) => c.notNull())
      .addColumn('seq', 'integer', (c) => c.notNull())
      .addColumn('fromCanvasId', 'text', (c) => c.notNull())
      .addColumn('toDocumentId', 'text', (c) => c.notNull())
      .addPrimaryKeyConstraint('workspaceIndexBacklinks_pk', ['workspaceId', 'seq'])
      .execute()
    // Backs listBacklinks' exact (workspaceId, toDocumentId) lookup.
    await db.schema
      .createIndex('workspaceIndexBacklinks_lookup')
      .on('workspaceIndexBacklinks')
      .columns(['workspaceId', 'toDocumentId'])
      .execute()

    await db.schema
      .createTable('workspaceIndexAliasHistory')
      .addColumn('workspaceId', 'text', (c) => c.notNull())
      .addColumn('seq', 'integer', (c) => c.notNull())
      .addColumn('alias', 'text', (c) => c.notNull())
      .addColumn('canvasId', 'text', (c) => c.notNull())
      .addColumn('retiredAtMs', 'integer', (c) => c.notNull())
      .addPrimaryKeyConstraint('workspaceIndexAliasHistory_pk', ['workspaceId', 'seq'])
      .execute()
    await db.schema
      .createIndex('workspaceIndexAliasHistory_lookup')
      .on('workspaceIndexAliasHistory')
      .columns(['workspaceId', 'alias'])
      .execute()
  },

  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable('workspaceIndexAliasHistory').execute()
    await db.schema.dropTable('workspaceIndexBacklinks').execute()
    await db.schema.dropTable('workspaceIndexAliases').execute()
    await db.schema.dropTable('workspaceIndexFacets').execute()
    await db.schema.dropTable('workspaceIndexDocumentList').execute()
  },
}
