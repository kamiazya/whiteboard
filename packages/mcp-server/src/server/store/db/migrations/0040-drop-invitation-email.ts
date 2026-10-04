import { type Kysely, sql } from 'kysely'
import type { Migration } from 'kysely/migration'

// The email invitation (ADR-0046 decision 6's second kind) was removed before
// anything could create one, so `email` and its index carry nothing. A link
// invitation is the only kind left, and it always has a token hash.
//
// SQLite refuses to drop a column a CHECK constraint names, and
// `invitations_one_kind` names `email`, so the table is rebuilt: create the
// new shape, copy, drop the old table (which takes its indexes with it), and
// rename. A row with no token hash is an email invitation, which could never
// be redeemed, so it is not copied.
export const migration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .createTable('invitations_next')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('tokenHash', 'text', (col) => col.notNull().unique())
      .addColumn('invitedBy', 'text', (col) => col.notNull())
      .addColumn('createdAt', 'integer', (col) => col.notNull())
      .addColumn('expiresAt', 'integer', (col) => col.notNull())
      .addColumn('redeemedAt', 'integer')
      .addColumn('redeemedBy', 'text')
      .addColumn('tenantId', 'text', (col) => col.notNull())
      .addColumn('workspaceId', 'text')
      .execute()
    await sql`
      insert into invitations_next
        (id, tokenHash, invitedBy, createdAt, expiresAt, redeemedAt, redeemedBy, tenantId, workspaceId)
      select id, tokenHash, invitedBy, createdAt, expiresAt, redeemedAt, redeemedBy, tenantId, workspaceId
      from invitations
      where tokenHash is not null
    `.execute(db)
    await db.schema.dropTable('invitations').execute()
    await db.schema.alterTable('invitations_next').renameTo('invitations').execute()
    await db.schema
      .createIndex('invitations_tenantId')
      .on('invitations')
      .column('tenantId')
      .execute()
  },
  async down(db: Kysely<unknown>): Promise<void> {
    // 0033's shape, with the column nullable again; every surviving row is a
    // link invitation, so the constraint holds with `email` null throughout.
    await db.schema
      .createTable('invitations_prev')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('tokenHash', 'text', (col) => col.unique())
      .addColumn('email', 'text')
      .addColumn('invitedBy', 'text', (col) => col.notNull())
      .addColumn('createdAt', 'integer', (col) => col.notNull())
      .addColumn('expiresAt', 'integer', (col) => col.notNull())
      .addColumn('redeemedAt', 'integer')
      .addColumn('redeemedBy', 'text')
      .addColumn('tenantId', 'text', (col) => col.notNull())
      .addColumn('workspaceId', 'text')
      .addCheckConstraint('invitations_one_kind', sql`(tokenHash is null) <> (email is null)`)
      .execute()
    await sql`
      insert into invitations_prev
        (id, tokenHash, invitedBy, createdAt, expiresAt, redeemedAt, redeemedBy, tenantId, workspaceId)
      select id, tokenHash, invitedBy, createdAt, expiresAt, redeemedAt, redeemedBy, tenantId, workspaceId
      from invitations
    `.execute(db)
    await db.schema.dropTable('invitations').execute()
    await db.schema.alterTable('invitations_prev').renameTo('invitations').execute()
    await db.schema
      .createIndex('invitations_tenantId')
      .on('invitations')
      .column('tenantId')
      .execute()
    await db.schema.createIndex('invitations_email').on('invitations').column('email').execute()
  },
}
