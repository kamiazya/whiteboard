/**
 * ADR-0049 decision 1: what a workspace's owners manage — who its members
 * are and which of them are owners. The product never leaves a workspace
 * without an owner, so demoting or removing the last one is refused. A
 * deactivated owner still counts: deactivating a person must not quietly
 * hand their workspaces to nobody, and the operator's `grant-member`
 * recovers a workspace whose owners are all deactivated.
 */
import { inTenantTransaction, type TenantScoped } from '../store/db/tenant-database.js'

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

// Whether taking `profileId` out of the owners would leave none, and whether
// they are a member at all. Read inside the caller's transaction, so two
// owners demoting each other at once cannot both pass.
async function standing(db: TenantScoped, workspaceId: string, profileId: string) {
  const owners = await db
    .selectFrom('workspaceMemberships')
    .select('profileId')
    .where('workspaceId', '=', workspaceId)
    .where('role', '=', 'owner')
    .execute()
  const role = await db
    .selectFrom('workspaceMemberships')
    .select('role')
    .where('workspaceId', '=', workspaceId)
    .where('profileId', '=', profileId)
    .executeTakeFirst()
  if (role === undefined) return 'not-a-member' as const
  const others = owners.filter((row) => row.profileId !== profileId)
  return role.role === 'owner' && others.length === 0 ? ('last-owner' as const) : ('ok' as const)
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

export function createWorkspaceRoles(db: TenantScoped): WorkspaceRoles {
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

    setRole: (workspaceId, profileId, role) =>
      inTenantTransaction(db, async (trx) => {
        const now = await standing(trx, workspaceId, profileId)
        if (now === 'not-a-member' || (now === 'last-owner' && role === 'member')) return now
        await trx
          .updateTable('workspaceMemberships')
          .set({ role })
          .where('workspaceId', '=', workspaceId)
          .where('profileId', '=', profileId)
          .execute()
        return 'ok'
      }),

    remove: (workspaceId, profileId) =>
      inTenantTransaction(db, async (trx) => {
        const now = await standing(trx, workspaceId, profileId)
        if (now !== 'ok') return now
        await trx
          .deleteFrom('workspaceMemberships')
          .where('workspaceId', '=', workspaceId)
          .where('profileId', '=', profileId)
          .execute()
        return 'ok'
      }),
  }
}
