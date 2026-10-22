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
import {
  inTenantTransaction,
  type TenantScoped,
  type TenantTransaction,
} from '../store/db/tenant-database.js'
import type { AuthenticatorBinding } from './member-profile-store.js'
import { administersNow } from './user-deactivation.js'
import { moveIntoNamespace, oldestOwnerNamespaceWithRoom } from './workspace-namespace-home.js'

type UserDeletionOutcome =
  | { readonly kind: 'deleted' }
  | { readonly kind: 'unknown-user' }
  | { readonly kind: 'not-deactivated' }
  | { readonly kind: 'sole-owner'; readonly workspaceIds: readonly string[] }
  | { readonly kind: 'not-an-administrator' }

export interface UserDeletion {
  /**
   * `by` is the administrator deleting them, refused when they no longer
   * administer the tenant by the time the deletion runs; null for the
   * operator, who is not held to it.
   */
  delete(profileId: string, by: string | null): Promise<UserDeletionOutcome>
}

interface UserDeletionOptions {
  /** The administrators the sign-in configuration names (ADR-0049 decision 2). */
  readonly configuredAdministrators?: readonly AuthenticatorBinding[]
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

// Moves every workspace the person's namespace holds to its inheritor, their
// oldest surviving owner (ADR-0053 decision 4) whose namespace has room under
// the workspace ceiling. A deletion is not refused for an inheritor at the
// ceiling, nor does it push one past it: that owner is skipped for the next.
// A workspace with no owner left, or none with room, goes to `me`, which no
// server-mode user can hold and which counts toward nobody's ceiling, so it
// stays reachable by its id until an operator's grant homes it.
async function rehomeTheirNamespace(trx: TenantTransaction, profileId: string, handle: string) {
  const held = await trx
    .selectFrom('workspaces')
    .select(['id', 'segment'])
    .where('namespace', '=', handle)
    .orderBy('id')
    .execute()
  for (const workspace of held) {
    await moveIntoNamespace(
      trx,
      workspace,
      await oldestOwnerNamespaceWithRoom(trx, workspace.id, profileId),
      { handedOver: true },
    )
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
  options: UserDeletionOptions = {},
): UserDeletion {
  const configured = options.configuredAdministrators ?? []
  return {
    async delete(profileId, by) {
      const outcome = await inTenantTransaction(db, async (trx) => {
        if (by !== null && !(await administersNow(trx, configured, by))) {
          return { kind: 'not-an-administrator' } as const
        }
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
