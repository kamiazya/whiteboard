import type { Kysely } from 'kysely'
import type { Migration } from 'kysely/migration'

// Which client began an attempt, as a digest of its network source, so a full
// table sheds the attempts of whoever filled it rather than everybody's
// oldest. An attempt begun before the upgrade has no source; it gets the
// empty one, which is a source like any other and lives its ten minutes out.
export const migration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .alterTable('signInAttempts')
      .addColumn('source', 'text', (col) => col.notNull().defaultTo(''))
      .execute()
    await db.schema
      .createIndex('signInAttempts_source')
      .on('signInAttempts')
      .columns(['source', 'expiresAt'])
      .execute()
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropIndex('signInAttempts_source').execute()
    await db.schema.alterTable('signInAttempts').dropColumn('source').execute()
  },
}
