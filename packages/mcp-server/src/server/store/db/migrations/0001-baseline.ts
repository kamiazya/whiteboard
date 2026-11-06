import type { CreateTableBuilder, Kysely } from 'kysely'
import type { Migration } from 'kysely/migration'

// The whole schema in one step, equal to `schema.ts` (`schema-conformance.test.ts`
// holds the two to each other, column by column, nullability and defaults
// included). A database written under the retired history before it is refused
// by name rather than upgraded: `published-migration-names.ts` lists that history.
//
// Every tenant-scoped table (`tenant-scope.ts`) carries a `tenantId` the
// schema does not declare: the tenant-bound handle stamps it on every insert,
// so the column has no default.
//
// No foreign key except chunk -> snapshot header: every other relation is swept
// explicitly by the code that owns it, so a delete never cascades into rows a
// store did not expect to lose. Foreign-key enforcement is per connection in
// SQLite, so the pragma lives in `db/index.ts`, not here.

// The tenant a single-person keeper is, spelled here rather than imported: a
// migration records what it wrote, and a later rename of the constant must not
// change what this step did to databases that already ran it.
const SELF_HOST_TENANT_ID = 'self-host'

function tenantScoped<T extends string, C extends string>(
  table: CreateTableBuilder<T, C>,
): CreateTableBuilder<T, C | 'tenantId'> {
  return table.addColumn('tenantId', 'text', (c) => c.notNull())
}

async function tenantIndex(db: Kysely<unknown>, table: string): Promise<void> {
  await db.schema.createIndex(`${table}_tenantId`).on(table).column('tenantId').execute()
}

export const migration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await tenantScoped(
      db.schema
        .createTable('workspaces')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('displayName', 'text')
        .addColumn('createdAt', 'integer', (c) => c.notNull())
        .addColumn('updatedAt', 'integer', (c) => c.notNull())
        .addColumn('segment', 'text')
        .addColumn('replicaTier', 'text'),
    )
      .addColumn('namespace', 'text', (c) => c.notNull().defaultTo('me'))
      .execute()
    await tenantIndex(db, 'workspaces')
    await db.schema
      .createIndex('workspaces_namespace_segment_unique')
      .on('workspaces')
      .columns(['tenantId', 'namespace', 'segment'])
      .unique()
      .execute()

    await tenantScoped(
      db.schema
        .createTable('versions')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('documentId', 'text', (c) => c.notNull())
        .addColumn('workspaceId', 'text', (c) => c.notNull())
        .addColumn('auto', 'integer', (c) => c.notNull())
        .addColumn('label', 'text')
        .addColumn('operatorKind', 'text', (c) => c.notNull())
        .addColumn('operatorActor', 'text', (c) => c.notNull())
        .addColumn('operatorDisplayName', 'text')
        .addColumn('operatorAgentId', 'text')
        .addColumn('operatorWorkspaceId', 'text')
        .addColumn('elementCount', 'integer', (c) => c.notNull())
        .addColumn('frontiers', 'text', (c) => c.notNull())
        .addColumn('contentDigest', 'text', (c) => c.notNull())
        .addColumn('createdAt', 'integer', (c) => c.notNull())
        .addColumn('restoredFrom', 'text')
        .addColumn('attestation', 'text'),
    ).execute()
    await tenantIndex(db, 'versions')
    await db.schema
      .createIndex('versions_document_idx')
      .on('versions')
      .columns(['documentId', 'createdAt'])
      .execute()
    await db.schema
      .createIndex('versions_workspace_id')
      .on('versions')
      .column('workspaceId')
      .execute()

    await db.schema
      .createTable('runtime')
      .addColumn('key', 'text', (c) => c.primaryKey())
      .addColumn('value', 'text')
      .addColumn('updatedAt', 'integer', (c) => c.notNull())
      .execute()

    await tenantScoped(
      db.schema
        .createTable('documentSnapshots')
        .addColumn('docKey', 'text', (c) => c.primaryKey())
        .addColumn('chunkCount', 'integer', (c) => c.notNull())
        .addColumn('totalBytes', 'integer', (c) => c.notNull())
        .addColumn('maxChunkBytes', 'integer', (c) => c.notNull())
        .addColumn('frontier', 'blob', (c) => c.notNull())
        .addColumn('generation', 'integer', (c) => c.notNull().defaultTo(1)),
    ).execute()
    await tenantIndex(db, 'documentSnapshots')

    await tenantScoped(
      db.schema
        .createTable('documentSnapshotChunks')
        .addColumn('docKey', 'text', (c) =>
          c.notNull().references('documentSnapshots.docKey').onDelete('cascade'),
        )
        .addColumn('chunkIndex', 'integer', (c) => c.notNull())
        .addColumn('bytes', 'blob', (c) => c.notNull()),
    )
      .addPrimaryKeyConstraint('documentSnapshotChunks_pk', ['docKey', 'chunkIndex'])
      .execute()
    await tenantIndex(db, 'documentSnapshotChunks')

    await tenantScoped(
      db.schema
        .createTable('documentDeltas')
        .addColumn('docKey', 'text', (c) => c.notNull())
        .addColumn('seq', 'integer', (c) => c.notNull())
        .addColumn('bytes', 'blob', (c) => c.notNull())
        .addColumn('frontier', 'blob', (c) => c.notNull()),
    )
      .addPrimaryKeyConstraint('documentDeltas_pk', ['docKey', 'seq'])
      .execute()
    await tenantIndex(db, 'documentDeltas')

    await tenantScoped(
      db.schema
        .createTable('documentFrontiers')
        .addColumn('docKey', 'text', (c) => c.primaryKey())
        .addColumn('frontier', 'blob', (c) => c.notNull()),
    ).execute()
    await tenantIndex(db, 'documentFrontiers')

    await db.schema
      .createTable('leases')
      .addColumn('name', 'text', (c) => c.primaryKey())
      .addColumn('holder', 'text', (c) => c.notNull())
      .addColumn('expiresAt', 'integer', (c) => c.notNull())
      .execute()

    await tenantScoped(
      db.schema
        .createTable('memberProfiles')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('displayName', 'text', (c) => c.notNull())
        .addColumn('accountId', 'text', (c) => c.notNull())
        .addColumn('handle', 'text', (c) => c.notNull())
        .addColumn('createdAt', 'integer', (c) => c.notNull())
        .addColumn('updatedAt', 'integer', (c) => c.notNull())
        .addColumn('deactivatedAt', 'integer'),
    ).execute()
    await tenantIndex(db, 'memberProfiles')
    await db.schema
      .createIndex('memberProfiles_tenant_account')
      .on('memberProfiles')
      .columns(['tenantId', 'accountId'])
      .unique()
      .execute()
    await db.schema
      .createIndex('memberProfiles_handle_unique')
      .on('memberProfiles')
      .columns(['tenantId', 'handle'])
      .unique()
      .execute()

    await db.schema
      .createTable('accounts')
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('createdAt', 'integer', (c) => c.notNull())
      .execute()

    await db.schema
      .createTable('accountBindings')
      .addColumn('authenticator', 'text', (c) => c.notNull())
      .addColumn('subject', 'text', (c) => c.notNull())
      .addColumn('accountId', 'text', (c) => c.notNull())
      .addColumn('createdAt', 'integer', (c) => c.notNull())
      .addPrimaryKeyConstraint('accountBindings_pk', ['authenticator', 'subject'])
      .execute()
    await db.schema
      .createIndex('accountBindings_accountId')
      .on('accountBindings')
      .column('accountId')
      .execute()

    await tenantScoped(
      db.schema
        .createTable('invitations')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('tokenHash', 'text', (c) => c.notNull().unique())
        .addColumn('invitedBy', 'text', (c) => c.notNull())
        .addColumn('createdAt', 'integer', (c) => c.notNull())
        .addColumn('expiresAt', 'integer', (c) => c.notNull())
        .addColumn('redeemedAt', 'integer')
        .addColumn('redeemedBy', 'text')
        .addColumn('workspaceId', 'text'),
    ).execute()
    await tenantIndex(db, 'invitations')

    await tenantScoped(
      db.schema
        .createTable('signInSessions')
        .addColumn('tokenHash', 'text', (c) => c.primaryKey())
        .addColumn('authenticator', 'text', (c) => c.notNull())
        .addColumn('subject', 'text', (c) => c.notNull())
        .addColumn('createdAt', 'integer', (c) => c.notNull())
        .addColumn('expiresAt', 'integer', (c) => c.notNull())
        .addColumn('authenticatedAt', 'integer'),
    ).execute()
    await tenantIndex(db, 'signInSessions')

    await tenantScoped(
      db.schema
        .createTable('signInAttempts')
        .addColumn('state', 'text', (c) => c.primaryKey())
        .addColumn('browserBindingHash', 'text', (c) => c.notNull())
        .addColumn('providerId', 'text', (c) => c.notNull())
        .addColumn('nonce', 'text', (c) => c.notNull())
        .addColumn('codeVerifier', 'text', (c) => c.notNull())
        .addColumn('invitationTokenHash', 'text')
        .addColumn('returnTo', 'text', (c) => c.notNull())
        .addColumn('expiresAt', 'integer', (c) => c.notNull())
        .addColumn('source', 'text', (c) => c.notNull())
        .addColumn('sourcePrefix48', 'text', (c) => c.notNull())
        .addColumn('sourcePrefix56', 'text', (c) => c.notNull())
        .addColumn('fresh', 'integer', (c) => c.notNull().defaultTo(0)),
    ).execute()
    await tenantIndex(db, 'signInAttempts')
    await db.schema
      .createIndex('signInAttempts_source')
      .on('signInAttempts')
      .columns(['source', 'expiresAt'])
      .execute()
    await db.schema
      .createIndex('signInAttempts_sourcePrefixes')
      .on('signInAttempts')
      .columns(['sourcePrefix48', 'sourcePrefix56', 'source', 'expiresAt'])
      .execute()

    await tenantScoped(
      db.schema
        .createTable('workspaceMemberships')
        .addColumn('workspaceId', 'text', (c) => c.notNull())
        .addColumn('profileId', 'text', (c) => c.notNull())
        .addColumn('createdAt', 'integer', (c) => c.notNull())
        .addColumn('role', 'text', (c) => c.notNull()),
    )
      .addPrimaryKeyConstraint('workspaceMemberships_pk', ['workspaceId', 'profileId'])
      .execute()
    await tenantIndex(db, 'workspaceMemberships')

    await tenantScoped(
      db.schema
        .createTable('tenantAdministrators')
        .addColumn('profileId', 'text', (c) => c.primaryKey())
        .addColumn('appointedBy', 'text')
        .addColumn('appointedAt', 'integer', (c) => c.notNull()),
    ).execute()
    await tenantIndex(db, 'tenantAdministrators')

    await tenantScoped(
      db.schema
        .createTable('workspaceReplicaKeys')
        .addColumn('workspaceId', 'text', (c) => c.primaryKey())
        .addColumn('key', 'blob', (c) => c.notNull())
        .addColumn('salt', 'blob', (c) => c.notNull())
        .addColumn('createdAt', 'integer', (c) => c.notNull()),
    ).execute()
    await tenantIndex(db, 'workspaceReplicaKeys')

    await db.schema
      .createTable('tenants')
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('createdAt', 'integer', (c) => c.notNull())
      .execute()
    await (db as Kysely<{ tenants: { id: string; createdAt: number } }>)
      .insertInto('tenants')
      .values({ id: SELF_HOST_TENANT_ID, createdAt: Date.now() })
      .execute()
  },
}
