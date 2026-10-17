/**
 * ADR-0049 decision 4: deactivating a user is reversible and keeps their
 * data. It refuses them from then on — `profileForBinding` answers nobody for
 * a deactivated user, and every gate asks it — and ends the sessions they
 * hold, so reactivating means signing in again rather than resuming one.
 */
import type { ExpressionBuilder } from 'kysely'
import type { DatabaseSchema } from '../store/db/schema.js'
import { inTenantTransaction, type TenantScoped } from '../store/db/tenant-database.js'
import type { AuthenticatorBinding } from './member-profile-store.js'

type KeptAdministrator = 'deactivated' | 'unchanged' | 'last-administrator'

export interface UserDeactivation {
  /** False when there is no such user or they are already deactivated. */
  deactivate(profileId: string, now: number): Promise<boolean>
  /**
   * `deactivate`, refusing the tenant's last active administrator — what an
   * administrator's request goes through. The operator at the machine can
   * appoint another from the command line, so it is not held to this.
   */
  deactivateKeepingAnAdministrator(profileId: string, now: number): Promise<KeptAdministrator>
  /** False when there is no such user or they are not deactivated. */
  reactivate(profileId: string): Promise<boolean>
}

interface UserDeactivationOptions {
  /** The administrators the sign-in configuration names (ADR-0049 decision 2). */
  readonly configuredAdministrators?: readonly AuthenticatorBinding[]
}

type Target = ExpressionBuilder<DatabaseSchema, 'memberProfiles'>

// The configuration's administrators are bindings, not rows, so they are
// matched through an account's bindings (administrator-check.ts).
function namedBinding(
  b: ExpressionBuilder<DatabaseSchema, 'accountBindings'>,
  configured: readonly AuthenticatorBinding[],
) {
  return b.or(
    configured.map((admin) =>
      b.and([
        b('accountBindings.authenticator', '=', admin.authenticator),
        b('accountBindings.subject', '=', admin.subject),
      ]),
    ),
  )
}

// Whether the row being deactivated administers this tenant.
function isAdministrator(eb: Target, configured: readonly AuthenticatorBinding[]) {
  const appointed = eb.exists(
    eb
      .selectFrom('tenantAdministrators')
      .select('tenantAdministrators.profileId')
      .whereRef('tenantAdministrators.profileId', '=', 'memberProfiles.id'),
  )
  if (configured.length === 0) return appointed
  const named = eb.exists(
    eb
      .selectFrom('accountBindings')
      .select('accountBindings.accountId')
      .whereRef('accountBindings.accountId', '=', 'memberProfiles.accountId')
      .where((b) => namedBinding(b, configured)),
  )
  return eb.or([appointed, named])
}

// Whether an administrator other than the row being deactivated is active.
function anotherActiveAdministrator(eb: Target, configured: readonly AuthenticatorBinding[]) {
  const appointed = eb.exists(
    eb
      .selectFrom('tenantAdministrators')
      .innerJoin('memberProfiles as other', 'other.id', 'tenantAdministrators.profileId')
      .select('other.id')
      .whereRef('other.id', '!=', 'memberProfiles.id')
      .where('other.deactivatedAt', 'is', null),
  )
  if (configured.length === 0) return appointed
  const named = eb.exists(
    eb
      .selectFrom('accountBindings')
      .innerJoin('memberProfiles as other', 'other.accountId', 'accountBindings.accountId')
      .select('other.id')
      .whereRef('other.id', '!=', 'memberProfiles.id')
      .where('other.deactivatedAt', 'is', null)
      .where((b) => namedBinding(b, configured)),
  )
  return eb.or([appointed, named])
}

// The guard the deactivating UPDATE carries: the row may change unless it is
// an administrator's and no other active one remains. One statement, as
// workspace-roles.ts's keepsAnOwner, so two administrators deactivating each
// other at once cannot both pass.
function keepsAnAdministrator(configured: readonly AuthenticatorBinding[]) {
  return (eb: Target) =>
    eb.or([eb.not(isAdministrator(eb, configured)), anotherActiveAdministrator(eb, configured)])
}

export function createUserDeactivation(
  db: TenantScoped,
  options: UserDeactivationOptions = {},
): UserDeactivation {
  const configured = options.configuredAdministrators ?? []
  const deactivateWhere = (profileId: string, now: number, keepAnAdministrator: boolean) =>
    inTenantTransaction(db, async (trx) => {
      let update = trx
        .updateTable('memberProfiles')
        .set({ deactivatedAt: now })
        .where('id', '=', profileId)
        .where('deactivatedAt', 'is', null)
      if (keepAnAdministrator) update = update.where(keepsAnAdministrator(configured))
      const user = await update.returning('accountId').executeTakeFirst()
      if (user === undefined) return false
      // A session names a binding, not a user, so each of the account's
      // bindings is ended here.
      const bindings = await trx
        .selectFrom('accountBindings')
        .select(['authenticator', 'subject'])
        .where('accountId', '=', user.accountId)
        .execute()
      for (const { authenticator, subject } of bindings) {
        await trx
          .deleteFrom('signInSessions')
          .where('authenticator', '=', authenticator)
          .where('subject', '=', subject)
          .execute()
      }
      return true
    })
  return {
    deactivate: (profileId, now) => deactivateWhere(profileId, now, false),

    async deactivateKeepingAnAdministrator(profileId, now) {
      if (await deactivateWhere(profileId, now, true)) return 'deactivated'
      // Why nothing changed: already deactivated (or nobody), or the last one.
      const row = await db
        .selectFrom('memberProfiles')
        .select('deactivatedAt')
        .where('id', '=', profileId)
        .executeTakeFirst()
      return row === undefined || row.deactivatedAt !== null ? 'unchanged' : 'last-administrator'
    },

    async reactivate(profileId) {
      const cleared = await db
        .updateTable('memberProfiles')
        .set({ deactivatedAt: null })
        .where('id', '=', profileId)
        .where('deactivatedAt', 'is not', null)
        .returning('id')
        .execute()
      return cleared.length > 0
    },
  }
}
