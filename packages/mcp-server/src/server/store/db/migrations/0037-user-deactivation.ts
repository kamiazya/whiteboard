import type { Kysely } from 'kysely'
import type { Migration } from 'kysely/migration'

// ADR-0049 decision 4: an administrator can deactivate a user and reverse it.
// The user row stays, with everything it owns and every membership it holds;
// `deactivatedAt` alone says they are refused, so reactivating is clearing it.
export const migration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema.alterTable('memberProfiles').addColumn('deactivatedAt', 'integer').execute()
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.alterTable('memberProfiles').dropColumn('deactivatedAt').execute()
  },
}
