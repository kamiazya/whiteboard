import type { Kysely } from 'kysely'
import type { Migration } from 'kysely/migration'

// Whether an attempt asked the provider for a sign-in made now (ADR-0051's
// re-authentication), so the callback can hold the ID token's `auth_time` to
// it. An attempt begun before the upgrade did not record it and is read as an
// ordinary one; administration still checks `auth_time` itself.
export const migration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .alterTable('signInAttempts')
      .addColumn('fresh', 'integer', (col) => col.notNull().defaultTo(0))
      .execute()
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.alterTable('signInAttempts').dropColumn('fresh').execute()
  },
}
