import type { Kysely } from 'kysely'
import type { Migration } from 'kysely/migration'

// ADR-0051 decision 5: when the identity provider last authenticated the
// person a session belongs to, from the ID token's `auth_time`. Null when the
// provider did not say, which every existing session is.
export const migration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema.alterTable('signInSessions').addColumn('authenticatedAt', 'integer').execute()
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.alterTable('signInSessions').dropColumn('authenticatedAt').execute()
  },
}
