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

interface SignInAttemptStoreOptions {
  /** The most attempts kept in flight for one tenant at once. */
  readonly maxPending?: number
}

// Beginning an attempt needs no credential, so without a ceiling a flood of
// begins grows the table for as long as it lasts. When full, the OLDEST
// attempt goes rather than the new one being refused: refusing would let a
// flood of this size every ten minutes lock everybody out of signing in,
// while eviction only costs a person whose attempt is older than the last
// ten thousand begun, which takes a flood far faster than that to reach.
// The returnTo and invitation the route stores are both bounded, so a full
// table is a few tens of megabytes at most.
const DEFAULT_MAX_PENDING = 10_000

const random = () => randomBytes(32).toString('base64url')
export function createSignInAttemptStore(
  db: TenantDatabase,
  { maxPending = DEFAULT_MAX_PENDING }: SignInAttemptStoreOptions = {},
): SignInAttemptStore {
  // Room for the attempt about to be inserted.
  const keep = Math.max(maxPending - 1, 0)
  return {
    async begin({ providerId, returnTo, invitationToken, now, ttlMs }) {
      // An attempt nobody finished is otherwise never removed; beginning one
      // sheds them, at the rate of sign-ins and with no worker to declare.
      await db.deleteFrom('signInAttempts').where('expiresAt', '<=', now).execute()
      const overflow = await db
        .selectFrom('signInAttempts')
        .select('state')
        .orderBy('expiresAt', 'desc')
        .limit(-1)
        .offset(keep)
        .execute()
      if (overflow.length > 0) {
        await db
          .deleteFrom('signInAttempts')
          .where(
            'state',
            'in',
            overflow.map((row) => row.state),
          )
          .execute()
      }
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
