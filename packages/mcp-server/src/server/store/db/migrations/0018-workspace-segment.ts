import type { Kysely, Migration } from 'kysely'

// ADR-0019: a workspace's user-facing handle. Nullable — legacy workspaces
// minted before this migration have none until Wave-2 backfill/minting, and
// there is no value to invent for them. The UNIQUE index is the registry's
// enforcement of "unique per keeper" (ADR-0019's user-facing layer);
// SQLite's unique-index semantics treat every NULL as distinct from every
// other NULL, so any number of legacy rows can coexist under no segment at
// all — only two NON-NULL rows sharing one segment collide.
export const migration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema.alterTable('workspaces').addColumn('segment', 'text').execute()
    await db.schema
      .createIndex('workspaces_segment_unique')
      .on('workspaces')
      .column('segment')
      .unique()
      .execute()
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropIndex('workspaces_segment_unique').execute()
    await db.schema.alterTable('workspaces').dropColumn('segment').execute()
  },
}
