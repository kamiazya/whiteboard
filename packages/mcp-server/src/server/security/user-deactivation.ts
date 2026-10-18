/**
 * ADR-0049 decision 4: deactivating a user is reversible and keeps their
 * data. It refuses them from then on — `profileForBinding` answers nobody for
 * a deactivated user, and every gate asks it — and ends the sessions they
 * hold, so reactivating means signing in again rather than resuming one.
 */
import { type ExpressionBuilder, expressionBuilder } from 'kysely'
import type { DatabaseSchema } from '../store/db/schema.js'
import { inTenantTransaction, type TenantScoped } from '../store/db/tenant-database.js'
import type { AuthenticatorBinding } from './member-profile-store.js'

type KeptAdministrator = 'deactivated' | 'unchanged' | 'last-administrator' | 'not-an-administrator'

export interface UserDeactivation {
  /** False when there is no such user or they are already deactivated. */
  deactivate(profileId: string, now: number): Promise<boolean>
  /**
   * `deactivate` on behalf of the administrator `by`, refusing the tenant's
   * last active administrator, and refusing outright when `by` no longer
   * administers it — what an administrator's request goes through. The
   * operator at the machine can appoint another from the command line, so it
   * is not held to this.
   */
  deactivateKeepingAnAdministrator(
    profileId: string,
    now: number,
    by: string,
  ): Promise<KeptAdministrator>
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
export function namedBinding(
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

/**
 * Whether `actorId` administers this tenant at the moment the statement
 * carrying this runs: an active user, appointed or named by the
 * configuration. A request is authorized before its change is made, so a
 * change guarded by this cannot land for someone dismissed or deactivated in
 * between.
 */
export function actorAdministers(configured: readonly AuthenticatorBinding[], actorId: string) {
  const eb = expressionBuilder<DatabaseSchema, never>()
  return eb.exists(
    eb
      .selectFrom('memberProfiles as actor')
      .select('actor.id')
      .where('actor.id', '=', actorId)
      .where('actor.deactivatedAt', 'is', null)
      .where((a) => {
        const appointed = a.exists(
          a
            .selectFrom('tenantAdministrators as actorAppointment')
            .select('actorAppointment.profileId')
            .whereRef('actorAppointment.profileId', '=', 'actor.id'),
        )
        if (configured.length === 0) return appointed
        const named = a.exists(
          a
            .selectFrom('accountBindings')
            .select('accountBindings.accountId')
            .whereRef('accountBindings.accountId', '=', 'actor.accountId')
            .where((b) => namedBinding(b, configured)),
        )
        return a.or([appointed, named])
      }),
  )
}

// The guard the deactivating UPDATE carries: the row may change unless it is
// an administrator's and no other active one remains. One statement, as
// workspace-roles.ts's keepsAnOwner, so two administrators deactivating each
// other at once cannot both pass.
function keepsAnAdministrator(configured: readonly AuthenticatorBinding[]) {
  return (eb: Target) =>
    eb.or([eb.not(isAdministrator(eb, configured)), anotherActiveAdministrator(eb, configured)])
}

// Deactivates the row and ends its sessions; `keepFor` set, only while it
// leaves another active administrator (those configured included).
function deactivateRow(
  db: TenantScoped,
  keepFor: { readonly configured: readonly AuthenticatorBinding[]; readonly by: string } | null,
  profileId: string,
  now: number,
): Promise<boolean> {
  return inTenantTransaction(db, async (trx) => {
    let update = trx
      .updateTable('memberProfiles')
      .set({ deactivatedAt: now })
      .where('id', '=', profileId)
      .where('deactivatedAt', 'is', null)
    if (keepFor !== null) {
      const { configured, by } = keepFor
      update = update
        .where(keepsAnAdministrator(configured))
        .where(actorAdministers(configured, by))
    }
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
}

export function createUserDeactivation(
  db: TenantScoped,
  options: UserDeactivationOptions = {},
): UserDeactivation {
  const configured = options.configuredAdministrators ?? []
  return {
    deactivate: (profileId, now) => deactivateRow(db, null, profileId, now),

    async deactivateKeepingAnAdministrator(profileId, now, by) {
      if (await deactivateRow(db, { configured, by }, profileId, now)) return 'deactivated'
      // Why nothing changed, read after the fact, so it names the outcome
      // and decides nothing: already deactivated (or nobody), the last
      // administrator, or an actor who no longer administers.
      const row = await db
        .selectFrom('memberProfiles')
        .select((eb) => ['deactivatedAt', eb.not(keepsAnAdministrator(configured)(eb)).as('last')])
        .where('id', '=', profileId)
        .executeTakeFirst()
      if (row === undefined || row.deactivatedAt !== null) return 'unchanged'
      return row.last ? 'last-administrator' : 'not-an-administrator'
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
