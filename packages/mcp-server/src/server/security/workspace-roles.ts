/**
 * ADR-0049 decision 1: what a workspace's owners manage — who its members
 * are and which of them are owners. The product never leaves a workspace
 * without an owner, so demoting or removing the last one is refused. A
 * deactivated owner still counts: deactivating a person must not quietly
 * hand their workspaces to nobody, and the operator's `grant-member`
 * recovers a workspace whose owners are all deactivated.
 */
import type { WorkspaceRole } from '@kamiazya/whiteboard-daemon-client/api-contracts/workspace-people'
import { type ExpressionBuilder, expressionBuilder } from 'kysely'
import type { DatabaseSchema } from '../store/db/schema.js'
import {
  inTenantTransaction,
  type TenantScoped,
  type TenantTransaction,
} from '../store/db/tenant-database.js'
import { moveIntoNamespace, oldestOwnerNamespace } from './workspace-namespace-home.js'

export interface WorkspaceMember {
  readonly profile: { readonly id: string; readonly displayName: string }
  readonly role: WorkspaceRole
  readonly deactivated: boolean
}

/** `not-an-owner` answers only a change made on an owner's behalf. */
type RoleChange = 'ok' | 'not-a-member' | 'last-owner' | 'not-an-owner'

export interface WorkspaceRoles {
  list(workspaceId: string): Promise<WorkspaceMember[]>
  /** Whether this tenant has a user by that id — what adding one checks first. */
  isUser(profileId: string): Promise<boolean>
  /** The operator's change, from the command line: nobody is acting. */
  setRole(workspaceId: string, profileId: string, role: WorkspaceRole): Promise<RoleChange>
  remove(workspaceId: string, profileId: string): Promise<RoleChange>
  /**
   * The same changes on behalf of `by`, an owner's request: refused unless
   * `by` is still an active owner of the workspace when the change runs, so
   * an owner demoted, removed or deactivated after the request was
   * authorized cannot land it.
   */
  setRoleAsOwner(
    workspaceId: string,
    profileId: string,
    role: WorkspaceRole,
    by: string,
  ): Promise<RoleChange>
  removeAsOwner(workspaceId: string, profileId: string, by: string): Promise<RoleChange>
  /** Admits a user as a plain member; an owner acting means it is not the first. */
  addAsOwner(workspaceId: string, profileId: string, by: string): Promise<'ok' | 'not-an-owner'>
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

// Whether `actorId` is an active owner of the workspace at the moment the
// statement carrying this runs — what the route's pre-check asked
// (`callerOwns`), asked again where it cannot go stale.
export function actorOwns(workspaceId: string, actorId: string) {
  const eb = expressionBuilder<DatabaseSchema, never>()
  return eb.exists(
    eb
      .selectFrom('workspaceMemberships as actorMembership')
      .innerJoin('memberProfiles as actor', 'actor.id', 'actorMembership.profileId')
      .select('actor.id')
      .where('actorMembership.workspaceId', '=', workspaceId)
      .where('actorMembership.profileId', '=', actorId)
      .where('actorMembership.role', '=', 'owner')
      .where('actor.deactivatedAt', 'is', null),
  )
}

export async function ownsNow(trx: TenantScoped, workspaceId: string, actorId: string) {
  const row = await trx.selectNoFrom(actorOwns(workspaceId, actorId).as('owns')).executeTakeFirst()
  return Boolean(row?.owns)
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

// A workspace held in the namespace of somebody who just stopped owning it
// moves to its oldest remaining owner (ADR-0053 decision 4's rule). Left
// where it was, its former holder could still learn its segment through
// their own namespace's collisions — a create's suffix, a rename's 409.
async function rehomeFrom(trx: TenantTransaction, workspaceId: string, profileId: string) {
  const held = await trx
    .selectFrom('workspaces')
    .innerJoin('memberProfiles', 'memberProfiles.handle', 'workspaces.namespace')
    .select(['workspaces.id', 'workspaces.segment'])
    .where('workspaces.id', '=', workspaceId)
    .where('memberProfiles.id', '=', profileId)
    .executeTakeFirst()
  if (held === undefined) return
  await moveIntoNamespace(trx, held, await oldestOwnerNamespace(trx, workspaceId, profileId))
}

// `by` null is the operator, who is held to the last-owner rule alone.
function setRole(
  db: TenantScoped,
  workspaceId: string,
  profileId: string,
  role: WorkspaceRole,
  by: string | null,
): Promise<RoleChange> {
  return inTenantTransaction(db, async (trx) => {
    let update = trx
      .updateTable('workspaceMemberships')
      .set({ role })
      .where('workspaceId', '=', workspaceId)
      .where('profileId', '=', profileId)
    if (role === 'member') update = update.where(keepsAnOwner(workspaceId, profileId))
    if (by !== null) update = update.where(actorOwns(workspaceId, by))
    const changed = await update.returning('profileId').execute()
    if (changed.length === 0) {
      if (by !== null && !(await ownsNow(trx, workspaceId, by))) return 'not-an-owner'
      return refusal(trx, workspaceId, profileId)
    }
    if (role === 'member') await rehomeFrom(trx, workspaceId, profileId)
    return 'ok'
  })
}

function remove(
  db: TenantScoped,
  workspaceId: string,
  profileId: string,
  by: string | null,
): Promise<RoleChange> {
  return inTenantTransaction(db, async (trx) => {
    let removal = trx
      .deleteFrom('workspaceMemberships')
      .where('workspaceId', '=', workspaceId)
      .where('profileId', '=', profileId)
      .where(keepsAnOwner(workspaceId, profileId))
    if (by !== null) removal = removal.where(actorOwns(workspaceId, by))
    const removed = await removal.returning('profileId').execute()
    if (removed.length === 0) {
      if (by !== null && !(await ownsNow(trx, workspaceId, by))) return 'not-an-owner'
      return refusal(trx, workspaceId, profileId)
    }
    await rehomeFrom(trx, workspaceId, profileId)
    return 'ok'
  })
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

    setRole: (workspaceId, profileId, role) => setRole(db, workspaceId, profileId, role, null),
    remove: (workspaceId, profileId) => remove(db, workspaceId, profileId, null),
    setRoleAsOwner: (workspaceId, profileId, role, by) =>
      setRole(db, workspaceId, profileId, role, by),
    removeAsOwner: (workspaceId, profileId, by) => remove(db, workspaceId, profileId, by),

    // An insert, which the tenant scope does not take from a select, so the
    // check is a read in the same transaction; a transaction here takes the
    // write lock as it begins (`BEGIN IMMEDIATE`, busy-retry.ts).
    addAsOwner: (workspaceId, profileId, by) =>
      inTenantTransaction(db, async (trx) => {
        if (!(await ownsNow(trx, workspaceId, by))) return 'not-an-owner'
        await trx
          .insertInto('workspaceMemberships')
          .values({ workspaceId, profileId, createdAt: Date.now(), role: 'member' })
          .onConflict((oc) => oc.columns(['workspaceId', 'profileId']).doNothing())
          .execute()
        return 'ok'
      }),
  }
}
