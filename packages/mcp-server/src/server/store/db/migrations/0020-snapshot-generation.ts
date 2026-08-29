import type { Kysely, Migration } from 'kysely'

// ADR-0020: the fencing token that makes a fold conditional.
//
// NOT NULL with a default of 1 rather than 0, matching what a fresh snapshot
// is given from here on. The value itself carries no meaning — a caller only
// compares it for equality — but starting existing rows at the same number a
// new row gets keeps the two stores' observable answers alike, which is what
// the libSQL/in-memory parity property reads.
export const migration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .alterTable('documentSnapshots')
      .addColumn('generation', 'integer', (col) => col.notNull().defaultTo(1))
      .execute()
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.alterTable('documentSnapshots').dropColumn('generation').execute()
  },
}
