import type { Kysely } from 'kysely'
import type { Migration } from 'kysely/migration'

// User decision 2026-09-22: a keeper holds tenants — self-host exactly one,
// SaaS many — and the self-host tenant is EXPLICIT, so going SaaS is more
// rows rather than a migration over existing data. Every tenant-scoped table
// carries the tenant and every query filters on it; the filter is the
// tenant-bound handle (`tenant-database.ts`), not a convention.
//
// Why a column on every table rather than one on `workspaces`: that table is
// not authoritative for workspace ids (see 0030's header), so a tenant there
// would be absent for exactly the ids that most need scoping.
//
// The table list and the tenant id are FROZEN here, not imported from
// `tenant-scope.ts`: a migration states the shape at its own point in the
// log. `tenant-database.test.ts` pins that the live ledger and the migrated
// schema agree.
//
// ponytail: the column is `not null default 'self-host'`, because SQLite's
// ADD COLUMN needs a default for NOT NULL and a rebuild of twelve tables is
// not worth it at one tenant. The default means a raw-handle insert lands in
// the self-host tenant rather than failing — which is why stores receive only
// the tenant-bound handle. Keys stay global too (a ULID is unique anyway), so
// two tenants cannot hold the same key; rebuild with the tenant in each
// primary key if tenants ever mint colliding ids.
const SELF_HOST_TENANT_ID = 'self-host'
const TENANT_SCOPED_TABLES = [
  'workspaces',
  'versions',
  'documentSnapshots',
  'documentSnapshotChunks',
  'documentDeltas',
  'documentFrontiers',
  'memberProfiles',
  'profileCredentials',
  'workspaceMemberships',
  'workspaceReplicaKeys',
  'workspaceMembersOnly',
] as const

interface MigrationSchema {
  tenants: { id: string; createdAt: number }
}

export const migration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .createTable('tenants')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('createdAt', 'integer', (col) => col.notNull())
      .execute()
    await (db as Kysely<MigrationSchema>)
      .insertInto('tenants')
      .values({ id: SELF_HOST_TENANT_ID, createdAt: Date.now() })
      .execute()
    for (const table of TENANT_SCOPED_TABLES) {
      await db.schema
        .alterTable(table)
        .addColumn('tenantId', 'text', (col) => col.notNull().defaultTo(SELF_HOST_TENANT_ID))
        .execute()
      await db.schema.createIndex(`${table}_tenantId`).on(table).column('tenantId').execute()
    }
  },
  async down(db: Kysely<unknown>): Promise<void> {
    for (const table of TENANT_SCOPED_TABLES) {
      await db.schema.dropIndex(`${table}_tenantId`).execute()
      await db.schema.alterTable(table).dropColumn('tenantId').execute()
    }
    await db.schema.dropTable('tenants').execute()
  },
}
