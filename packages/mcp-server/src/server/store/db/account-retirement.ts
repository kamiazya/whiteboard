/**
 * ADR-0051 decision 2: retiring an account nobody's user names any more.
 *
 * An account and its authenticator bindings are keeper-wide (ADR-0045): one
 * account can be a user in several tenants, and a store bound to one tenant
 * cannot see the others. So this is the one people operation that reaches the
 * database around the tenant-bound handle, and it only ever removes the
 * keeper-wide rows of an account that no tenant's user still names.
 */
import { type Database, getRawDb } from './index.js'

/** True when the account was retired; false when some tenant still names it. */
export async function retireAccountIfUnheld(db: Database, accountId: string): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    const held = await trx
      .selectFrom('memberProfiles')
      .select('id')
      .where('accountId', '=', accountId)
      .executeTakeFirst()
    if (held !== undefined) return false
    await trx.deleteFrom('accountBindings').where('accountId', '=', accountId).execute()
    await trx.deleteFrom('accounts').where('id', '=', accountId).execute()
    return true
  })
}

/**
 * The retirement a keeper's deletion calls, over that keeper's whole
 * database. The handle is opened when an account is retired, not when the
 * keeper starts: it is memoized per data dir, and nothing else needs it.
 */
export function accountRetirementFor(dataDir: string): (accountId: string) => Promise<boolean> {
  return async (accountId) => retireAccountIfUnheld(await getRawDb(dataDir), accountId)
}
