/**
 * ADR-0046 decision 1: the session a sign-in opens at a tenant's host. The
 * token is handed out once (it becomes a host-only cookie) and only its hash
 * is stored. A session names the person as the binding an authenticator
 * vouched for; what that person may reach is decided per request, so a
 * removed membership bites without the session being touched.
 */
import { createHash, randomBytes } from 'node:crypto'
import type { TenantDatabase } from '../store/db/tenant-database.js'
import type { AuthenticatorBinding } from './member-profile-store.js'

/** Host-only (`__Host-`): the browser sends it back to exactly this origin. */
export const SESSION_COOKIE = '__Host-wb_session'

export interface SignInSessionStore {
  create(person: AuthenticatorBinding, now: number, ttlMs: number): Promise<string>
  resolve(token: string, now: number): Promise<AuthenticatorBinding | null>
  end(token: string): Promise<boolean>
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function createSignInSessionStore(db: TenantDatabase): SignInSessionStore {
  return {
    async create(person, now, ttlMs) {
      // Nothing else removes an expired session, so opening one sheds them —
      // without a background worker to declare, and bounded by the rate of
      // sign-ins rather than by the table's age.
      await db.deleteFrom('signInSessions').where('expiresAt', '<=', now).execute()
      const token = randomBytes(32).toString('base64url')
      await db
        .insertInto('signInSessions')
        .values({
          tokenHash: hashToken(token),
          authenticator: person.authenticator,
          subject: person.subject,
          createdAt: now,
          expiresAt: now + ttlMs,
        })
        .execute()
      return token
    },

    async resolve(token, now) {
      const row = await db
        .selectFrom('signInSessions')
        .select(['authenticator', 'subject'])
        .where('tokenHash', '=', hashToken(token))
        .where('expiresAt', '>', now)
        .executeTakeFirst()
      return row ?? null
    },

    async end(token) {
      const deleted = await db
        .deleteFrom('signInSessions')
        .where('tokenHash', '=', hashToken(token))
        .returning('tokenHash')
        .execute()
      return deleted.length > 0
    },
  }
}
