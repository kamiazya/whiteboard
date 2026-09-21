import type { Kysely } from 'kysely'
import type { Migration } from 'kysely/migration'

// User decision 2026-09-21: a workspace that has ever had a member stays
// person-gated even after its last member is removed — removing the SOLE
// member must not revert `workspaceAccess` to origin trust. `since` is set
// once, on first `addMember`, and `revokeL1Membership` never clears it.
//
// One row per workspace, kept OUTSIDE `workspaces` on purpose: that table
// has no row for every workspace id membership can name (this store's own
// property test and workspace-access.test.ts both gate 'ws-1' against an
// isolated DB that never creates a `workspaces` row), so an
// `UPDATE workspaces SET ... WHERE id = ?` would update zero rows SILENTLY
// on exactly the workspace being closed, and the gate would fall open. A row
// in its own table exists whenever the membership row that triggered it
// does, independent of whether `workspaces` has ever heard of the id.
//
// No foreign key — house style since 0016/0017; delete paths sweep rows
// explicitly and a deleted workspace's marker is left as a harmless orphan
// (that workspace already 404s before this gate is ever reached).
//
// Backfill: every workspace that already has at least one row in
// `workspaceMemberships` when this migration runs is marked, `since` the
// earliest of its membership rows. A workspace whose members were ALL
// removed BEFORE this migration ran has no membership row left and is not
// backfilled — that history is not recoverable.

// Local, frozen at this migration's own point in the log — see
// 0007-adopt-workspace-tree.ts's header for why a migration casts to its
// own shape rather than importing the live `DatabaseSchema`.
interface MigrationSchema {
  workspaceMemberships: { workspaceId: string; profileId: string; createdAt: number }
  workspaceMembersOnly: { workspaceId: string; since: number }
}

export const migration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .createTable('workspaceMembersOnly')
      .addColumn('workspaceId', 'text', (col) => col.primaryKey())
      .addColumn('since', 'integer', (col) => col.notNull())
      .execute()
    const tdb = db as Kysely<MigrationSchema>
    await tdb
      .insertInto('workspaceMembersOnly')
      .columns(['workspaceId', 'since'])
      .expression((eb) =>
        eb
          .selectFrom('workspaceMemberships')
          .select((sub) => ['workspaceId', sub.fn.min('createdAt').as('since')])
          .groupBy('workspaceId'),
      )
      .execute()
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable('workspaceMembersOnly').execute()
  },
}
