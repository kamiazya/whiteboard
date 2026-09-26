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
 * Their account is keeper-wide (ADR-0045) and may still be another tenant's
 * user, so retiring it is handed to `retireAccount`, which can see every
 * tenant; this store sees one.
 */
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
          .select(['accountId', 'deactivatedAt'])
          .where('id', '=', profileId)
          .executeTakeFirst()
        if (user === undefined) return { kind: 'unknown-user' } as const
        if (user.deactivatedAt === null) return { kind: 'not-deactivated' } as const
        const workspaceIds = await soleOwnerOf(trx, profileId)
        if (workspaceIds.length > 0) return { kind: 'sole-owner', workspaceIds } as const
        await removeTheirRows(trx, profileId, user.accountId)
        return { kind: 'deleted', accountId: user.accountId } as const
      })
      if (outcome.kind !== 'deleted') return outcome
      await retireAccount(outcome.accountId)
      return { kind: 'deleted' }
    },
  }
}
