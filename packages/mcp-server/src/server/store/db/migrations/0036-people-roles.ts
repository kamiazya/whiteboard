import { type Kysely, sql } from 'kysely'
import type { Migration } from 'kysely/migration'

// ADR-0049 decisions 1 and 2: a membership carries a role, and a tenant keeps
// the administrators it has appointed.
//
// The role is `owner` or `member`. Each existing workspace's EARLIEST
// membership becomes its owner, which is what the store does from here on for
// a workspace's first member: the one who created it, or the one the operator
// granted it to. Everyone after is a member.
//
// ponytail: `role` is nullable at the column level because SQLite's ADD
// COLUMN cannot add NOT NULL without a default; every row is filled here and
// every insert the store makes carries one.
//
// `tenantAdministrators` is tenant-scoped and created WITH its `tenantId`
// column, as every table born after 0031 is. Administrators named in
// configuration are not rows here; they are checked where a request is.
//
// FROZEN like every migration: the role values are spelled here.
export const migration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema.alterTable('workspaceMemberships').addColumn('role', 'text').execute()
    await sql`
      update workspaceMemberships set role = case
        when createdAt = (
          select min(m2.createdAt) from workspaceMemberships m2
          where m2.tenantId = workspaceMemberships.tenantId
            and m2.workspaceId = workspaceMemberships.workspaceId
        ) then 'owner' else 'member' end
    `.execute(db)
    await db.schema
      .createTable('tenantAdministrators')
      // A user id is a ULID, unique across tenants, so it is the key alone;
      // the tenant-bound handle cannot name `tenantId` in a conflict target.
      .addColumn('profileId', 'text', (col) => col.primaryKey())
      .addColumn('appointedBy', 'text')
      .addColumn('appointedAt', 'integer', (col) => col.notNull())
      .addColumn('tenantId', 'text', (col) => col.notNull())
      .execute()
    await db.schema
      .createIndex('tenantAdministrators_tenantId')
      .on('tenantAdministrators')
      .column('tenantId')
      .execute()
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable('tenantAdministrators').execute()
    await db.schema.alterTable('workspaceMemberships').dropColumn('role').execute()
  },
}
