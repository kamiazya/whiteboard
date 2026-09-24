import { type Kysely, sql } from 'kysely'
import type { Migration } from 'kysely/migration'

// ADR-0046 decision 6: an invitation creates a tenant's USER for whichever
// account accepts it. Two shapes share the table — a one-time LINK (only the
// token's SHA-256 is kept, so a database read hands nobody a usable link)
// and an EMAIL invitation (lowercased address, honoured only where the
// provider asserts it verified). Exactly one of `tokenHash`/`email` is set.
//
// Tenant-scoped, and created WITH its `tenantId` column: 0031 added the
// column to the tables that existed then, and a table born after it carries
// its own. No default — the tenant-bound handle stamps every insert.
//
// Revocation is a plain delete (ADR-0042 decision 3's reasoning: undoing one
// costs nothing), so there is no revoked state to store.
export const migration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .createTable('invitations')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('tokenHash', 'text', (col) => col.unique())
      .addColumn('email', 'text')
      .addColumn('invitedBy', 'text', (col) => col.notNull())
      .addColumn('createdAt', 'integer', (col) => col.notNull())
      .addColumn('expiresAt', 'integer', (col) => col.notNull())
      .addColumn('redeemedAt', 'integer')
      .addColumn('redeemedBy', 'text')
      .addColumn('tenantId', 'text', (col) => col.notNull())
      .addCheckConstraint('invitations_one_kind', sql`(tokenHash is null) <> (email is null)`)
      .execute()
    await db.schema
      .createIndex('invitations_tenantId')
      .on('invitations')
      .column('tenantId')
      .execute()
    await db.schema.createIndex('invitations_email').on('invitations').column('email').execute()
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable('invitations').execute()
  },
}
