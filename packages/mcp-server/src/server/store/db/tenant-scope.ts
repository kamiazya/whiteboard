import type { DatabaseSchema } from './schema.js'

/**
 * Which tables a tenant owns rows in. Every key of `DatabaseSchema` is
 * classified, so a table added without an answer does not typecheck; the
 * tenant-bound handle (`tenant-database.ts`) and the migration's column set
 * both read this one table, so neither can drift from it.
 *
 * `keeper-wide` carries its reason: a table left unscoped is a decision a
 * reader can check, not an omission.
 */
type TenantScope = 'tenant' | `keeper-wide: ${string}`

const TENANT_SCOPE = {
  workspaces: 'tenant',
  versions: 'tenant',
  documentSnapshots: 'tenant',
  documentSnapshotChunks: 'tenant',
  documentDeltas: 'tenant',
  documentFrontiers: 'tenant',
  // A User is who a person is INSIDE one tenant; the keeper-wide Account a
  // passkey authenticates is a later layer above it and does not change this.
  memberProfiles: 'tenant',
  profileCredentials: 'tenant',
  workspaceMemberships: 'tenant',
  workspaceReplicaKeys: 'tenant',
  workspaceMembersOnly: 'tenant',
  leases: 'keeper-wide: leader election between instances of one keeper, about the process',
  runtime: 'keeper-wide: the local daemon’s own settings, such as its current workspace',
  tenants: 'keeper-wide: the list of tenants itself',
} as const satisfies Record<keyof DatabaseSchema, TenantScope>

type TenantScopedTable = {
  [T in keyof typeof TENANT_SCOPE]: (typeof TENANT_SCOPE)[T] extends 'tenant' ? T : never
}[keyof typeof TENANT_SCOPE]

export const TENANT_SCOPED_TABLES: ReadonlySet<string> = new Set(
  Object.entries(TENANT_SCOPE)
    .filter(([, scope]) => scope === 'tenant')
    .map(([table]) => table),
)

export function isTenantScoped(table: string): table is TenantScopedTable {
  return TENANT_SCOPED_TABLES.has(table)
}

/**
 * The one tenant a self-hosted keeper holds. Its row is created by the
 * migration that introduced tenants, so a self-host is a keeper with one
 * row in `tenants` and SaaS is the same shape with more.
 */
export const SELF_HOST_TENANT_ID = 'self-host'
