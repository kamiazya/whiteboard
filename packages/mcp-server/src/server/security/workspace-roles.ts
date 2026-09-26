/**
 * ADR-0049 decision 1: what a workspace's owners manage — who its members
 * are and which of them are owners. The product never leaves a workspace
 * without an owner, so demoting or removing the last one is refused. A
 * deactivated owner still counts: deactivating a person must not quietly
 * hand their workspaces to nobody, and the operator's `grant-member`
 * recovers a workspace whose owners are all deactivated.
 *
 * On the local daemon the machine's owner owns every workspace (decision 5),
 * so no workspace there is ever ownerless and the rule does not apply:
 * `ownedByTheMachine` lets its last recorded owner go.
 */
import type { ExpressionBuilder } from 'kysely'
import type { DatabaseSchema } from '../store/db/schema.js'
import type { TenantScoped } from '../store/db/tenant-database.js'

type WorkspaceRole = 'owner' | 'member'

export interface WorkspaceMember {
  readonly profile: { readonly id: string; readonly displayName: string }
  readonly role: WorkspaceRole
  readonly deactivated: boolean
}

type RoleChange = 'ok' | 'not-a-member' | 'last-owner'

export interface WorkspaceRoles {
  list(workspaceId: string): Promise<WorkspaceMember[]>
  /** Whether this tenant has a user by that id — what adding one checks first. */
  isUser(profileId: string): Promise<boolean>
  setRole(workspaceId: string, profileId: string, role: WorkspaceRole): Promise<RoleChange>
  remove(workspaceId: string, profileId: string): Promise<RoleChange>
}

// The guard every write carries: the row may change unless it is an owner's
// and no other owner of the same workspace remains. It rides in the write's
// own WHERE clause, so the check and the change are one statement — two
// owners demoting each other at once cannot both pass, and the loser is
// refused by the rule instead of failing on a lock a read-then-write
// transaction would have to upgrade.
function keepsAnOwner(workspaceId: string, profileId: string) {
  return (eb: ExpressionBuilder<DatabaseSchema, 'workspaceMemberships'>) =>
    eb.or([
      eb('workspaceMemberships.role', '=', 'member'),
      eb.exists(
        eb
          .selectFrom('workspaceMemberships as other')
          .select('other.profileId')
          .where('other.workspaceId', '=', workspaceId)
          .where('other.role', '=', 'owner')
          .where('other.profileId', '!=', profileId),
      ),
    ])
}

// Why a guarded write changed nothing: no such member, or its last owner.
async function refusal(db: TenantScoped, workspaceId: string, profileId: string) {
  const row = await db
    .selectFrom('workspaceMemberships')
    .select('profileId')
    .where('workspaceId', '=', workspaceId)
    .where('profileId', '=', profileId)
    .executeTakeFirst()
  return row === undefined ? ('not-a-member' as const) : ('last-owner' as const)
}

async function membersOf(db: TenantScoped, workspaceId: string): Promise<WorkspaceMember[]> {
  const rows = await db
    .selectFrom('workspaceMemberships')
    .innerJoin('memberProfiles', 'memberProfiles.id', 'workspaceMemberships.profileId')
    .select([
      'memberProfiles.id',
      'memberProfiles.displayName',
      'memberProfiles.deactivatedAt',
      'workspaceMemberships.role',
    ])
    .where('workspaceMemberships.workspaceId', '=', workspaceId)
    .orderBy('workspaceMemberships.createdAt', 'asc')
    .orderBy('memberProfiles.id', 'asc')
    .execute()
  return rows.map((row) => ({
    profile: { id: row.id, displayName: row.displayName },
    role: row.role,
    deactivated: row.deactivatedAt !== null,
  }))
}

export function createWorkspaceRoles(
  db: TenantScoped,
  { ownedByTheMachine = false }: { readonly ownedByTheMachine?: boolean } = {},
): WorkspaceRoles {
  return {
    list: (workspaceId) => membersOf(db, workspaceId),

    async isUser(profileId) {
      const row = await db
        .selectFrom('memberProfiles')
        .select('id')
        .where('id', '=', profileId)
        .executeTakeFirst()
      return row !== undefined
    },

    async setRole(workspaceId, profileId, role) {
      let update = db
        .updateTable('workspaceMemberships')
        .set({ role })
        .where('workspaceId', '=', workspaceId)
        .where('profileId', '=', profileId)
      if (role === 'member' && !ownedByTheMachine) {
        update = update.where(keepsAnOwner(workspaceId, profileId))
      }
      const changed = await update.returning('profileId').execute()
      return changed.length > 0 ? 'ok' : refusal(db, workspaceId, profileId)
    },

    async remove(workspaceId, profileId) {
      let remove = db
        .deleteFrom('workspaceMemberships')
        .where('workspaceId', '=', workspaceId)
        .where('profileId', '=', profileId)
      if (!ownedByTheMachine) remove = remove.where(keepsAnOwner(workspaceId, profileId))
      const removed = await remove.returning('profileId').execute()
      return removed.length > 0 ? 'ok' : refusal(db, workspaceId, profileId)
    },
  }
}
