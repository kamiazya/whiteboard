import type { Kysely } from 'kysely'
import type { Migration } from 'kysely/migration'

// The /48 and /56 an attempt's source sits in, as digests beside the /64 one,
// so a full table sheds by allocation level and one site's /64s cannot crowd
// everybody else out. An attempt begun before the upgrade gets the empty
// prefixes, one group like any other, and lives its ten minutes out.
export const migration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .alterTable('signInAttempts')
      .addColumn('sourcePrefix48', 'text', (col) => col.notNull().defaultTo(''))
      .execute()
    await db.schema
      .alterTable('signInAttempts')
      .addColumn('sourcePrefix56', 'text', (col) => col.notNull().defaultTo(''))
      .execute()
    await db.schema
      .createIndex('signInAttempts_sourcePrefixes')
      .on('signInAttempts')
      .columns(['sourcePrefix48', 'sourcePrefix56', 'source', 'expiresAt'])
      .execute()
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropIndex('signInAttempts_sourcePrefixes').execute()
    await db.schema.alterTable('signInAttempts').dropColumn('sourcePrefix56').execute()
    await db.schema.alterTable('signInAttempts').dropColumn('sourcePrefix48').execute()
  },
}
