import type { Kysely } from 'kysely'
import type { Migration } from 'kysely/migration'

// ADR-0046 decision 1: the session a sign-in at a tenant's host opens. Only
// the SHA-256 of the session token is kept, so a database read hands nobody a
// live session. It records WHO (the binding an authenticator vouched for),
// never what they may do: membership is looked up per request, so removing a
// member takes effect without touching their session.
//
// Tenant-scoped and created with its own `tenantId` (see 0033's header).
export const migration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .createTable('signInSessions')
      .addColumn('tokenHash', 'text', (col) => col.primaryKey())
      .addColumn('authenticator', 'text', (col) => col.notNull())
      .addColumn('subject', 'text', (col) => col.notNull())
      .addColumn('createdAt', 'integer', (col) => col.notNull())
      .addColumn('expiresAt', 'integer', (col) => col.notNull())
      .addColumn('tenantId', 'text', (col) => col.notNull())
      .execute()
    await db.schema
      .createIndex('signInSessions_tenantId')
      .on('signInSessions')
      .column('tenantId')
      .execute()
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable('signInSessions').execute()
  },
}
