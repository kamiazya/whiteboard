import type { Kysely } from 'kysely'
import type { Migration } from 'kysely/migration'

// ADR-0049 decision 3: an invitation may invite a person into a workspace.
// Null is an invitation to the tenant alone, which every existing row is.
export const migration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema.alterTable('invitations').addColumn('workspaceId', 'text').execute()
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.alterTable('invitations').dropColumn('workspaceId').execute()
  },
}
