/**
 * ADR-0046 decision 1: an authorization-code flow in flight. `begin` mints
 * the state, nonce, PKCE verifier and a browser binding (which the route sets
 * as a host-only cookie); `take` hands them back exactly once, and only to
 * the browser that began the attempt.
 */
import { randomBytes } from 'node:crypto'
import { sha256Hex } from '../../shared/sha256.js'
import type { TenantDatabase } from '../store/db/tenant-database.js'

interface BeginInput {
  readonly providerId: string
  readonly returnTo: string
  readonly invitationToken?: string
  readonly now: number
  readonly ttlMs: number
}

interface Attempt {
  readonly providerId: string
  readonly nonce: string
  readonly codeVerifier: string
  readonly invitationToken: string | null
  readonly returnTo: string
}

export interface SignInAttemptStore {
  begin(input: BeginInput): Promise<Attempt & { state: string; browserBinding: string }>
  take(state: string, browserBinding: string, now: number): Promise<Attempt | null>
}

const random = () => randomBytes(32).toString('base64url')
export function createSignInAttemptStore(db: TenantDatabase): SignInAttemptStore {
  return {
    async begin({ providerId, returnTo, invitationToken, now, ttlMs }) {
      // An attempt nobody finished is otherwise never removed; beginning one
      // sheds them, at the rate of sign-ins and with no worker to declare.
      await db.deleteFrom('signInAttempts').where('expiresAt', '<=', now).execute()
      const minted = {
        state: random(),
        browserBinding: random(),
        nonce: random(),
        // RFC 7636 section 4.1: 43-128 characters of the unreserved set;
        // 32 random bytes in base64url are 43.
        codeVerifier: random(),
        invitationToken: invitationToken ?? null,
        providerId,
        returnTo,
      }
      await db
        .insertInto('signInAttempts')
        .values({
          state: minted.state,
          browserBindingHash: sha256Hex(minted.browserBinding),
          providerId,
          nonce: minted.nonce,
          codeVerifier: minted.codeVerifier,
          invitationToken: minted.invitationToken,
          returnTo,
          expiresAt: now + ttlMs,
        })
        .execute()
      return minted
    },

    // One DELETE ... RETURNING: whichever request gets the row gets it, so a
    // replayed callback finds nothing.
    async take(state, browserBinding, now) {
      const [row] = await db
        .deleteFrom('signInAttempts')
        .where('state', '=', state)
        .where('browserBindingHash', '=', sha256Hex(browserBinding))
        .where('expiresAt', '>', now)
        .returning(['providerId', 'nonce', 'codeVerifier', 'invitationToken', 'returnTo'])
        .execute()
      return row ?? null
    },
  }
}
