import type { Kysely, Migration } from 'kysely'

// ADR-0008 (accepted): the WorkspaceIndex port and its five backing tables
// were write-only — every mutation reindexed into them, nothing ever read
// them back. Their one prospective consumer (an old-slug redirect) is
// deferred to ADR-0007 convergence, so the rows carry no live purpose.
// Drops rather than deprecates: migrations here are append-only (0004 stays
// in the log as a compatibility record for databases that already ran it),
// but the tables themselves have no reader to protect.
//
// `if exists` covers both paths a target DB can be in: one that ran 0004
// (has the tables) and a fresh one that never will (0004 still runs, so
// this is defensive, not the only guard).
export const migration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable('workspaceIndexAliasHistory').ifExists().execute()
    await db.schema.dropTable('workspaceIndexBacklinks').ifExists().execute()
    await db.schema.dropTable('workspaceIndexAliases').ifExists().execute()
    await db.schema.dropTable('workspaceIndexFacets').ifExists().execute()
    await db.schema.dropTable('workspaceIndexDocumentList').ifExists().execute()
  },

  // Irreversible by design (disposable-DB pre-1.0 policy): recreating five
  // dead tables on downgrade would resurrect machinery this migration
  // exists to remove.
  async down(): Promise<void> {},
}
