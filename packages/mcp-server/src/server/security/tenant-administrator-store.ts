/**
 * ADR-0049 decision 2: the administrators a tenant has appointed. The
 * operator appoints the first one from the command line; administrators
 * appoint the rest. Administrators named in configuration are not kept here:
 * that list is checked against the request, so removing a name takes effect
 * at the person's next request without anything to clean up.
 */
import type { TenantScoped } from '../store/db/tenant-database.js'

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
  isAppointed(profileId: string): Promise<boolean>
  /** Oldest appointment first. */
  list(): Promise<TenantAdministrator[]>
}

export function createTenantAdministratorStore(db: TenantScoped): TenantAdministratorStore {
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
    async isAppointed(profileId) {
      const row = await db
        .selectFrom('tenantAdministrators')
        .select('profileId')
        .where('profileId', '=', profileId)
        .executeTakeFirst()
      return row !== undefined
    },
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
