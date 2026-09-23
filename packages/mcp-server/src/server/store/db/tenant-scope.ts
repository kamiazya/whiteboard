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
  // A User is who a person is INSIDE one tenant (ADR-0045).
  memberProfiles: 'tenant',
  invitations: 'tenant',
  workspaceMemberships: 'tenant',
  workspaceReplicaKeys: 'tenant',
  workspaceMembersOnly: 'tenant',
  leases: 'keeper-wide: leader election between instances of one keeper, about the process',
  runtime: 'keeper-wide: the local daemon’s own settings, such as its current workspace',
  tenants: 'keeper-wide: the list of tenants itself',
  accounts:
    'keeper-wide: an account is who signs in, and belongs to no tenant (ADR-0045); the user row in each tenant names it, never the reverse',
  accountBindings: 'keeper-wide: what an authenticator vouched for, resolving to an account',
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
