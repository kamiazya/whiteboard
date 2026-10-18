/**
 * ADR-0049 decision 2: the administrators a tenant has appointed. The
 * operator appoints the first one from the command line; administrators
 * appoint the rest. Administrators named in configuration are not kept here:
 * that list is checked against the request, so removing a name takes effect
 * at the person's next request without anything to clean up.
 */
import type { TenantScoped } from '../store/db/tenant-database.js'
import type { AuthenticatorBinding } from './member-profile-store.js'
import { actorAdministers } from './user-deactivation.js'

interface TenantAdministrator {
  readonly profileId: string
  /** Who appointed them; null when the operator did, from the command line. */
  readonly appointedBy: string | null
  readonly appointedAt: number
}

export interface TenantAdministratorStore {
  /** Idempotent: an existing appointment is kept as it was. */
  appoint(profileId: string, appointedBy: string | null): Promise<void>
  /** Whether there was an appointment to remove. */
  dismiss(profileId: string): Promise<boolean>
  /**
   * `dismiss` on behalf of the administrator `by` — what an administrator's
   * request goes through — refused when `by` no longer administers the
   * tenant, or is the one dismissed, which together keep an active
   * administrator. The operator dismisses through `dismiss`.
   */
  dismissKeepingAnAdministrator(profileId: string, by: string): Promise<KeptAppointment>
  isAppointed(profileId: string): Promise<boolean>
  /** Oldest appointment first. */
  list(): Promise<TenantAdministrator[]>
}

type KeptAppointment = 'dismissed' | 'unchanged' | 'not-an-administrator'

interface TenantAdministratorStoreOptions {
  /** The administrators the sign-in configuration names (ADR-0049 decision 2). */
  readonly configuredAdministrators?: readonly AuthenticatorBinding[]
}

export function createTenantAdministratorStore(
  db: TenantScoped,
  options: TenantAdministratorStoreOptions = {},
): TenantAdministratorStore {
  const configured = options.configuredAdministrators ?? []
  const isAppointed = async (profileId: string) => {
    const row = await db
      .selectFrom('tenantAdministrators')
      .select('profileId')
      .where('profileId', '=', profileId)
      .executeTakeFirst()
    return row !== undefined
  }
  return {
    async appoint(profileId, appointedBy) {
      await db
        .insertInto('tenantAdministrators')
        .values({ profileId, appointedBy, appointedAt: Date.now() })
        .onConflict((oc) => oc.columns(['profileId']).doNothing())
        .execute()
    },
    async dismiss(profileId) {
      const deleted = await db
        .deleteFrom('tenantAdministrators')
        .where('profileId', '=', profileId)
        .returning('profileId')
        .execute()
      return deleted.length > 0
    },
    async dismissKeepingAnAdministrator(profileId, by) {
      // The actor is someone other than the person dismissed, so an actor
      // still administering in the same statement IS an active administrator
      // left behind. Two administrators
      // dismissing each other at once therefore cannot both land.
      const deleted = await db
        .deleteFrom('tenantAdministrators')
        .where('profileId', '=', profileId)
        .where('profileId', '!=', by)
        .where(actorAdministers(configured, by))
        .returning('profileId')
        .execute()
      if (deleted.length > 0) return 'dismissed'
      return (await isAppointed(profileId)) ? 'not-an-administrator' : 'unchanged'
    },
    isAppointed,
    async list() {
      return db
        .selectFrom('tenantAdministrators')
        .select(['profileId', 'appointedBy', 'appointedAt'])
        .orderBy('appointedAt', 'asc')
        .orderBy('profileId', 'asc')
        .execute()
    },
  }
}
