/**
 * ADR-0049 decision 4: deactivating a user is reversible and keeps their
 * data. It refuses them from then on — `profileForBinding` answers nobody for
 * a deactivated user, and every gate asks it — and ends the sessions they
 * hold, so reactivating means signing in again rather than resuming one.
 */
import { inTenantTransaction, type TenantScoped } from '../store/db/tenant-database.js'

export interface UserDeactivation {
  /** False when there is no such user or they are already deactivated. */
  deactivate(profileId: string, now: number): Promise<boolean>
  /** False when there is no such user or they are not deactivated. */
  reactivate(profileId: string): Promise<boolean>
}

export function createUserDeactivation(db: TenantScoped): UserDeactivation {
  return {
    deactivate: (profileId, now) =>
      inTenantTransaction(db, async (trx) => {
        const user = await trx
          .updateTable('memberProfiles')
          .set({ deactivatedAt: now })
          .where('id', '=', profileId)
          .where('deactivatedAt', 'is', null)
          .returning('accountId')
          .executeTakeFirst()
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
      }),

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
