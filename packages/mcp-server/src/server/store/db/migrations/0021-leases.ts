import type { Kysely, Migration } from 'kysely'

// ADR-0020's leader election, RENTED rather than written: a lease row in the
// database every instance already shares.
//
// One row per named lease. `expiresAt` is what makes a dead holder recover on
// its own — a pid means nothing to another container, so liveness here has to
// be time-based.
export const migration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .createTable('leases')
      .addColumn('name', 'text', (col) => col.primaryKey())
      .addColumn('holder', 'text', (col) => col.notNull())
      .addColumn('expiresAt', 'integer', (col) => col.notNull())
      .execute()
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable('leases').execute()
  },
}
