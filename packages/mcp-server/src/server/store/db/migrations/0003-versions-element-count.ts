import type { Kysely, Migration } from 'kysely'

// versions.elementCount records the live (non-tombstoned) element count at
// version save time. This is what the UI shows in the version history list,
// and computing it from the live doc on every list() would force every list
// caller to also load the snapshot.

export const migration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .alterTable('versions')
      .addColumn('elementCount', 'integer', (c) => c.notNull().defaultTo(0))
      .execute()
  },

  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.alterTable('versions').dropColumn('elementCount').execute()
  },
}
