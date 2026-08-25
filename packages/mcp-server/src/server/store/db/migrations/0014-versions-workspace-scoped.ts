import type { Kysely, Migration } from 'kysely'

// Add versions.workspaceScoped: 1 when the row's frontiers point into the
// WORKSPACE document's oplog (durable across restarts), 0 for rows written
// against a per-document doc's oplog — the legacy plane, still checked out
// against the legacy record. The flag is what lets `load` fork the right
// document; without it a workspace-scoped frontier would be checked out
// against a projection whose oplog is reborn every process, and every
// version would break on the first daemon restart.
export const migration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .alterTable('versions')
      .addColumn('workspaceScoped', 'integer', (col) => col.notNull().defaultTo(0))
      .execute()
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.alterTable('versions').dropColumn('workspaceScoped').execute()
  },
}
