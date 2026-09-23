import type { Kysely } from 'kysely'
import type { Migration } from 'kysely/migration'

// ADR-0046 decision 1: an authorization-code flow in flight — from the
// redirect to the provider until its callback. Kept in the database rather
// than in memory because a server-mode keeper may run several instances and
// the callback can land on any of them.
//
// `browserBindingHash` ties the attempt to the browser that began it (the
// value itself is a host-only cookie), which is what stops a login-CSRF: a
// callback carrying someone else's `state` finds nothing. The PKCE verifier
// and nonce are stored as-is because they are only useful together with an
// authorization code the provider issues to this browser, and the row lives
// minutes.
export const migration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .createTable('signInAttempts')
      .addColumn('state', 'text', (col) => col.primaryKey())
      .addColumn('browserBindingHash', 'text', (col) => col.notNull())
      .addColumn('providerId', 'text', (col) => col.notNull())
      .addColumn('nonce', 'text', (col) => col.notNull())
      .addColumn('codeVerifier', 'text', (col) => col.notNull())
      .addColumn('invitationToken', 'text')
      .addColumn('returnTo', 'text', (col) => col.notNull())
      .addColumn('expiresAt', 'integer', (col) => col.notNull())
      .addColumn('tenantId', 'text', (col) => col.notNull())
      .execute()
    await db.schema
      .createIndex('signInAttempts_tenantId')
      .on('signInAttempts')
      .column('tenantId')
      .execute()
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable('signInAttempts').execute()
  },
}
