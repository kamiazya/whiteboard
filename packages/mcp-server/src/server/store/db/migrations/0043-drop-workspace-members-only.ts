import type { Kysely } from 'kysely'
import type { Migration } from 'kysely/migration'

// 0030's marker recorded that a workspace had ever had a member, so emptying
// one could not fall back to origin trust. Every workspace is members-only
// regardless (ADR-0046 d10) and no gate reads the marker any more, so the
// table had become write-only.
//
// `down` rebuilds it as 0031 left it (tenant column and index) and backfills
// from the memberships still present, the same derivation 0030 used; a
// workspace whose members were all removed meanwhile is not recoverable.

// Frozen at this point in the log — see 0007-adopt-workspace-tree.ts's header.
const SELF_HOST_TENANT_ID = 'self-host'
interface MigrationSchema {
  workspaceMemberships: { workspaceId: string; createdAt: number; tenantId: string }
  workspaceMembersOnly: { workspaceId: string; since: number; tenantId: string }
}

export const migration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropIndex('workspaceMembersOnly_tenantId').execute()
    await db.schema.dropTable('workspaceMembersOnly').execute()
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .createTable('workspaceMembersOnly')
      .addColumn('workspaceId', 'text', (col) => col.primaryKey())
      .addColumn('since', 'integer', (col) => col.notNull())
      .addColumn('tenantId', 'text', (col) => col.notNull().defaultTo(SELF_HOST_TENANT_ID))
      .execute()
    await db.schema
      .createIndex('workspaceMembersOnly_tenantId')
      .on('workspaceMembersOnly')
      .column('tenantId')
      .execute()
    await (db as Kysely<MigrationSchema>)
      .insertInto('workspaceMembersOnly')
      .columns(['workspaceId', 'since', 'tenantId'])
      .expression((eb) =>
        eb
          .selectFrom('workspaceMemberships')
          .select((sub) => ['workspaceId', sub.fn.min('createdAt').as('since'), 'tenantId'])
          .groupBy(['workspaceId', 'tenantId']),
      )
      .execute()
  },
}
