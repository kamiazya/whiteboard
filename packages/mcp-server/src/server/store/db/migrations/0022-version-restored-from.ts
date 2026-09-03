import type { Kysely, Migration } from 'kysely'

// The version this point was produced by RESTORING, when it was.
//
// Nullable and with no default: the overwhelming majority of rows are not
// merges, and a sentinel would make "not a merge" and "a merge from the
// empty version" the same value. Existing rows stay null, which is correct
// rather than a gap — they were written before a restore recorded anything,
// so nothing can say whether they were merges.
export const migration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema.alterTable('versions').addColumn('restoredFrom', 'text').execute()
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.alterTable('versions').dropColumn('restoredFrom').execute()
  },
}
