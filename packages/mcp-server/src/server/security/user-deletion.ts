/**
 * ADR-0051 decisions 1 to 4: deleting a person. Deactivation is the
 * reversible step, so only a deactivated user can be deleted; deleting is
 * immediate and final. What they wrote stays; what identified them to this
 * tenant goes, and nothing is kept to recognise them by, so signing in again
 * is a newcomer under the ordinary admission rules.
 *
 * A record that names them by id — who appointed an administrator, who issued
 * an invitation already redeemed — keeps the id. Nothing resolves those ids
 * to a person, so there is no name left behind to scrub.
 *
 * The workspaces their namespace holds move to another owner in the same
 * transaction (ADR-0053 decision 4): their handle is free to choose again
 * once they are gone, and no workspace may be left in a namespace a stranger
 * could then hold.
 *
 * Their account is keeper-wide (ADR-0045) and may still be another tenant's
 * user, so retiring it is handed to `retireAccount`, which can see every
 * tenant; this store sees one.
 */
import { SINGLE_PERSON_NAMESPACE } from '@kamiazya/whiteboard-model'
import { firstFreeSegment } from '@kamiazya/whiteboard-workspace-index'
import {
  inTenantTransaction,
  type TenantScoped,
  type TenantTransaction,
} from '../store/db/tenant-database.js'

type UserDeletionOutcome =
  | { readonly kind: 'deleted' }
  | { readonly kind: 'unknown-user' }
  | { readonly kind: 'not-deactivated' }
  | { readonly kind: 'sole-owner'; readonly workspaceIds: readonly string[] }

export interface UserDeletion {
  delete(profileId: string): Promise<UserDeletionOutcome>
}

// Workspaces this person owns with no other owner. Another owner counts
// however deactivated, as it does for the last-owner rule (ADR-0049).
async function soleOwnerOf(trx: TenantTransaction, profileId: string) {
  const rows = await trx
    .selectFrom('workspaceMemberships as mine')
    .select('mine.workspaceId')
    .where('mine.profileId', '=', profileId)
    .where('mine.role', '=', 'owner')
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom('workspaceMemberships as other')
            .select('other.profileId')
            .whereRef('other.workspaceId', '=', 'mine.workspaceId')
            .where('other.role', '=', 'owner')
            .where('other.profileId', '!=', profileId),
        ),
      ),
    )
    .orderBy('mine.workspaceId')
    .execute()
  return rows.map((row) => row.workspaceId)
}

async function endSessions(trx: TenantTransaction, accountId: string) {
  const bindings = await trx
    .selectFrom('accountBindings')
    .select(['authenticator', 'subject'])
    .where('accountId', '=', accountId)
    .execute()
  for (const { authenticator, subject } of bindings) {
    await trx
      .deleteFrom('signInSessions')
      .where('authenticator', '=', authenticator)
      .where('subject', '=', subject)
      .execute()
  }
}

// The namespace a workspace moves to when its holder is deleted (ADR-0053
// decision 4): its oldest surviving owner's, by membership createdAt and then
// user id — the membership row's time, since no role-change time is stored.
// A workspace with no owner left goes to `me`, which no server-mode user can
// hold, so it stays reachable by its id until an operator grants it a member.
async function inheritorOf(trx: TenantTransaction, workspaceId: string, profileId: string) {
  const row = await trx
    .selectFrom('workspaceMemberships')
    .innerJoin('memberProfiles', 'memberProfiles.id', 'workspaceMemberships.profileId')
    .select('memberProfiles.handle')
    .where('workspaceMemberships.workspaceId', '=', workspaceId)
    .where('workspaceMemberships.role', '=', 'owner')
    .where('workspaceMemberships.profileId', '!=', profileId)
    .orderBy('workspaceMemberships.createdAt', 'asc')
    .orderBy('workspaceMemberships.profileId', 'asc')
    .limit(1)
    .executeTakeFirst()
  return row?.handle ?? SINGLE_PERSON_NAMESPACE
}

// Moves every workspace the person's namespace holds to its inheritor. A
// segment the inheritor's namespace already holds is suffixed there; the
// inheritor sees all of that namespace, so the suffix tells nobody anything.
// Past the suffix series' bound the workspace keeps no segment and is
// reached by its id.
async function rehomeTheirNamespace(trx: TenantTransaction, profileId: string, handle: string) {
  const held = await trx
    .selectFrom('workspaces')
    .select(['id', 'segment'])
    .where('namespace', '=', handle)
    .orderBy('id')
    .execute()
  for (const workspace of held) {
    const namespace = await inheritorOf(trx, workspace.id, profileId)
    const taken = async (segment: string) =>
      (await trx
        .selectFrom('workspaces')
        .select('id')
        .where('namespace', '=', namespace)
        .where('segment', '=', segment)
        .executeTakeFirst()) !== undefined
    const segment =
      workspace.segment === null
        ? null
        : ((await firstFreeSegment(workspace.segment, taken)) ?? null)
    await trx
      .updateTable('workspaces')
      .set({ namespace, segment, updatedAt: Date.now() })
      .where('id', '=', workspace.id)
      .execute()
  }
}

async function removeTheirRows(trx: TenantTransaction, profileId: string, accountId: string) {
  await trx.deleteFrom('workspaceMemberships').where('profileId', '=', profileId).execute()
  await trx.deleteFrom('tenantAdministrators').where('profileId', '=', profileId).execute()
  await trx
    .deleteFrom('invitations')
    .where('invitedBy', '=', profileId)
    .where('redeemedAt', 'is', null)
    .execute()
  await endSessions(trx, accountId)
  await trx.deleteFrom('memberProfiles').where('id', '=', profileId).execute()
}

export function createUserDeletion(
  db: TenantScoped,
  retireAccount: (accountId: string) => Promise<unknown>,
): UserDeletion {
  return {
    async delete(profileId) {
      const outcome = await inTenantTransaction(db, async (trx) => {
        const user = await trx
          .selectFrom('memberProfiles')
          .select(['accountId', 'deactivatedAt', 'handle'])
          .where('id', '=', profileId)
          .executeTakeFirst()
        if (user === undefined) return { kind: 'unknown-user' } as const
        if (user.deactivatedAt === null) return { kind: 'not-deactivated' } as const
        const workspaceIds = await soleOwnerOf(trx, profileId)
        if (workspaceIds.length > 0) return { kind: 'sole-owner', workspaceIds } as const
        await rehomeTheirNamespace(trx, profileId, user.handle)
        await removeTheirRows(trx, profileId, user.accountId)
        return { kind: 'deleted', accountId: user.accountId } as const
      })
      if (outcome.kind !== 'deleted') return outcome
      await retireAccount(outcome.accountId)
      return { kind: 'deleted' }
    },
  }
}
