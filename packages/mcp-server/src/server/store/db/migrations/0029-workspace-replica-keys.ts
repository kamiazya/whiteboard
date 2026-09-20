import type { Kysely } from 'kysely'
import type { Migration } from 'kysely/migration'

// The read plane's per-workspace content key (ADR-0042 decisions 1/3/5,
// ADR-0043 decision 3). One row per workspace, minted on first read and
// never rotated by this table — a rotation is a (not yet built) explicit
// route, not a side effect of a read. No epoch here: a document's own epoch
// lives beside that document's ciphertext (daemon-client's read-plane.ts),
// not on the workspace key.
//
// No foreign key — house style since 0016/0017. No seeded row: a workspace
// gets a key only when a member's session first asks for one.
//
// `workspaces.replicaTier` is nullable, meaning "use the process's
// WHITEBOARD_REPLICA_TIER default" — a workspace that has never had its tier
// set explicitly is not the same as one explicitly set to the default value,
// and nullable is how the two stay distinguishable.
export const migration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .createTable('workspaceReplicaKeys')
      .addColumn('workspaceId', 'text', (col) => col.primaryKey())
      .addColumn('key', 'blob', (col) => col.notNull())
      .addColumn('salt', 'blob', (col) => col.notNull())
      .addColumn('createdAt', 'integer', (col) => col.notNull())
      .execute()
    await db.schema.alterTable('workspaces').addColumn('replicaTier', 'text').execute()
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable('workspaceReplicaKeys').execute()
    await db.schema.alterTable('workspaces').dropColumn('replicaTier').execute()
  },
}
