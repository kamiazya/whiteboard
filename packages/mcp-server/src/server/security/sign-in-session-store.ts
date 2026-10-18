/**
 * ADR-0046 decision 1: the session a sign-in opens at a tenant's host. The
 * token is handed out once (it becomes a host-only cookie) and only its hash
 * is stored. A session names the person as the binding an authenticator
 * vouched for; what that person may reach is decided per request, so a
 * removed membership bites without the session being touched.
 */
import { randomBytes } from 'node:crypto'
import { sha256Hex } from '../../shared/sha256.js'
import {
  inTenantTransaction,
  type TenantDatabase,
  type TenantScoped,
} from '../store/db/tenant-database.js'
import type { AuthenticatorBinding } from './member-profile-store.js'

/** Host-only (`__Host-`): the browser sends it back to exactly this origin. */
export const SESSION_COOKIE = '__Host-wb_session'

/** A live session: whose it is, and when their provider last authenticated
 *  them (ADR-0051), or null when the provider did not say. */
interface OpenSession {
  readonly person: AuthenticatorBinding
  readonly authenticatedAt: number | null
}

export interface SignInSessionStore {
  create(
    person: AuthenticatorBinding,
    now: number,
    ttlMs: number,
    authenticatedAt?: number | null,
  ): Promise<string>
  /**
   * `create`, only while the person is an active user here — null when they
   * are deactivated or no user at all. The check and the insert share one
   * write transaction, so a deactivation cannot land between them and leave
   * a session that reactivating would resume.
   */
  createForActiveUser(
    person: AuthenticatorBinding,
    now: number,
    ttlMs: number,
    authenticatedAt?: number | null,
  ): Promise<string | null>
  open(token: string, now: number): Promise<OpenSession | null>
  resolve(token: string, now: number): Promise<AuthenticatorBinding | null>
  end(token: string): Promise<boolean>
}

async function openSession(db: TenantDatabase, token: string, now: number) {
  const row = await db
    .selectFrom('signInSessions')
    .select(['authenticator', 'subject', 'authenticatedAt'])
    .where('tokenHash', '=', sha256Hex(token))
    .where('expiresAt', '>', now)
    .executeTakeFirst()
  if (row === undefined) return null
  const { authenticatedAt, ...person } = row
  return { person, authenticatedAt }
}

async function insertSession(
  db: TenantScoped,
  person: AuthenticatorBinding,
  now: number,
  ttlMs: number,
  authenticatedAt: number | null,
): Promise<string> {
  // Nothing else removes an expired session, so opening one sheds them —
  // without a background worker to declare, and bounded by the rate of
  // sign-ins rather than by the table's age.
  await db.deleteFrom('signInSessions').where('expiresAt', '<=', now).execute()
  const token = randomBytes(32).toString('base64url')
  await db
    .insertInto('signInSessions')
    .values({
      tokenHash: sha256Hex(token),
      authenticator: person.authenticator,
      subject: person.subject,
      createdAt: now,
      expiresAt: now + ttlMs,
      authenticatedAt,
    })
    .execute()
  return token
}

export function createSignInSessionStore(db: TenantDatabase): SignInSessionStore {
  return {
    create: (person, now, ttlMs, authenticatedAt = null) =>
      insertSession(db, person, now, ttlMs, authenticatedAt),

    createForActiveUser: (person, now, ttlMs, authenticatedAt = null) =>
      inTenantTransaction(db, async (trx) => {
        const active = await trx
          .selectFrom('accountBindings')
          .innerJoin('memberProfiles', 'memberProfiles.accountId', 'accountBindings.accountId')
          .select('memberProfiles.id')
          .where('accountBindings.authenticator', '=', person.authenticator)
          .where('accountBindings.subject', '=', person.subject)
          .where('memberProfiles.deactivatedAt', 'is', null)
          .executeTakeFirst()
        if (active === undefined) return null
        return insertSession(trx, person, now, ttlMs, authenticatedAt)
      }),

    open: (token, now) => openSession(db, token, now),

    async resolve(token, now) {
      return (await openSession(db, token, now))?.person ?? null
    },

    async end(token) {
      const deleted = await db
        .deleteFrom('signInSessions')
        .where('tokenHash', '=', sha256Hex(token))
        .returning('tokenHash')
        .execute()
      return deleted.length > 0
    },
  }
}
