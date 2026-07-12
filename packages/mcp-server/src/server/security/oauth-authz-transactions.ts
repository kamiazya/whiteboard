// Authorization-transaction store for the hosted-origin OAuth 2.1
// authorization server (ADR-0005). This module owns the parts of the flow
// that must hold even before the `/authorize` approval UI exists in a later
// slice: PKCE enforcement at issuance and redemption, single-use
// hashed codes, and compare-and-swap redemption.
//
// Restart rule (ADR-0005 names this as a required, explicit decision, not
// optional): this store is an in-memory Map, nothing more. A daemon
// restart constructs a brand new `createOAuthTransactionStore()` instance,
// so every pending/approved/code-issued transaction from the previous
// process is simply gone. This is the "invalidate every outstanding
// transaction" branch of the ADR's either/or, chosen over durable
// persistence because there is no `/authorize` UI yet for a transaction to
// meaningfully survive for — a future slice that adds durable persistence
// would need to revisit this file, not silently accumulate state past a
// restart with no invalidation at all.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { AUTH_SCOPES, type AuthScope } from './auth-strategy.js'

// A transaction stays approvable for 5 minutes — long enough for a human to
// read and click an approval screen, short enough that a stale pending
// transaction is not a standing attack surface.
const TRANSACTION_TTL_MS = 5 * 60_000
// The authorization code itself is short-lived and single-use, per
// ADR-0005 ("short TTL"): 60 seconds is enough for the client's immediate
// redirect-then-exchange round trip.
const CODE_TTL_MS = 60_000
// The minted access token is deliberately short-lived; a renewal grant is
// designed in ADR-0005 but is explicitly out of scope for this slice.
const ACCESS_TOKEN_TTL_SECONDS = 15 * 60

const createTransactionInputSchema = z.object({
  clientId: z.string().min(1),
  redirectUri: z.string().min(1),
  scopes: z.array(z.enum(AUTH_SCOPES)).min(1),
  // Required per ADR-0005: "state is required — PKCE is not a substitute
  // for it". Enforced here, at the one call site every future /authorize
  // implementation must go through to create a transaction, rather than
  // left to that future caller to remember.
  state: z.string().min(1),
  codeChallenge: z.string().min(1),
  codeChallengeMethod: z.literal('S256'),
})

export type CreateTransactionInput = z.infer<typeof createTransactionInputSchema>

export type TransactionStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'code-issued'
  | 'redeemed'
  | 'expired'

interface TransactionRecord {
  id: string
  clientId: string
  redirectUri: string
  scopes: readonly AuthScope[]
  state: string
  codeChallenge: string
  codeChallengeMethod: 'S256'
  status: TransactionStatus
  createdAt: number
  expiresAt: number
  codeHash?: string
  codeExpiresAt?: number
}

export type RedeemAuthorizationCodeInput = {
  code: string
  clientId: string
  redirectUri: string
  codeVerifier: string | undefined
}

export type RedeemAuthorizationCodeResult =
  | { ok: true; transactionId: string; scopes: readonly AuthScope[]; clientId: string }
  | {
      ok: false
      reason:
        | 'invalid_request'
        | 'invalid_grant'
        | 'redirect_uri_mismatch'
        | 'pkce_verification_failed'
    }

function hashCode(rawCode: string): string {
  return createHash('sha256').update(rawCode).digest('hex')
}

// S256 per RFC 7636 §4.2: challenge = BASE64URL-ENCODE(SHA256(verifier)).
// A verifier-mismatch must not leak timing information about how much of
// the challenge matched, hence timingSafeEqual over the raw hash bytes.
function verifyPkce(codeChallenge: string, codeVerifier: string): boolean {
  const computedChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
  const computed = Buffer.from(computedChallenge)
  const expected = Buffer.from(codeChallenge)
  if (computed.length !== expected.length) return false
  return timingSafeEqual(computed, expected)
}

export interface OAuthTransactionStore {
  createTransaction(input: CreateTransactionInput): { transactionId: string; expiresAt: number }
  approveTransaction(transactionId: string): boolean
  issueAuthorizationCode(transactionId: string): { code: string } | null
  redeemAuthorizationCode(input: RedeemAuthorizationCodeInput): RedeemAuthorizationCodeResult
  mintAccessToken(
    scopes: readonly AuthScope[],
    clientId: string,
  ): { accessToken: string; expiresIn: number }
}

export function createOAuthTransactionStore(options?: {
  now?: () => number
}): OAuthTransactionStore {
  const now = options?.now ?? Date.now
  const transactions = new Map<string, TransactionRecord>()
  // Index from code hash to transaction id so redemption never has to scan
  // every pending transaction to find a match — and so the raw code is
  // never the map key either; only its hash ever lives in memory.
  const codeHashIndex = new Map<string, string>()

  function createTransaction(input: CreateTransactionInput): {
    transactionId: string
    expiresAt: number
  } {
    const parsed = createTransactionInputSchema.parse(input)
    const id = randomBytes(16).toString('base64url')
    const createdAt = now()
    const expiresAt = createdAt + TRANSACTION_TTL_MS
    transactions.set(id, {
      id,
      clientId: parsed.clientId,
      redirectUri: parsed.redirectUri,
      scopes: parsed.scopes,
      state: parsed.state,
      codeChallenge: parsed.codeChallenge,
      codeChallengeMethod: parsed.codeChallengeMethod,
      status: 'pending',
      createdAt,
      expiresAt,
    })
    return { transactionId: id, expiresAt }
  }

  function approveTransaction(transactionId: string): boolean {
    const record = transactions.get(transactionId)
    if (!record || record.status !== 'pending' || record.expiresAt < now()) return false
    transactions.set(transactionId, { ...record, status: 'approved' })
    return true
  }

  function issueAuthorizationCode(transactionId: string): { code: string } | null {
    const record = transactions.get(transactionId)
    if (!record || record.status !== 'approved' || record.expiresAt < now()) return null
    const rawCode = randomBytes(32).toString('base64url')
    const codeHash = hashCode(rawCode)
    const codeExpiresAt = now() + CODE_TTL_MS
    transactions.set(transactionId, { ...record, status: 'code-issued', codeHash, codeExpiresAt })
    codeHashIndex.set(codeHash, transactionId)
    return { code: rawCode }
  }

  function redeemAuthorizationCode(
    input: RedeemAuthorizationCodeInput,
  ): RedeemAuthorizationCodeResult {
    // Rejected before any lookup: a request with no code_verifier at all
    // must fail server-side, not merely be documented as required
    // (ADR-0005's explicit trap).
    if (!input.codeVerifier) {
      return { ok: false, reason: 'invalid_request' }
    }

    const codeHash = hashCode(input.code)
    const transactionId = codeHashIndex.get(codeHash)
    if (!transactionId) return { ok: false, reason: 'invalid_grant' }
    const record = transactions.get(transactionId)
    if (!record) return { ok: false, reason: 'invalid_grant' }

    // Compare-and-swap: the status check and the transition to 'redeemed'
    // happen in the same synchronous step, before any further validation
    // (client_id, redirect_uri, PKCE, expiry). Node's run-to-completion
    // semantics make this block atomic as long as nothing here awaits
    // between the check and the `transactions.set` — two concurrent
    // callers racing the same code cannot both observe 'code-issued' and
    // both proceed past this point. Whichever caller loses the race
    // reads 'redeemed' (or a status this function already moved past) and
    // fails here, even if its own credentials would otherwise have been
    // valid — once a code is spent, it is spent.
    if (record.status !== 'code-issued') {
      return { ok: false, reason: 'invalid_grant' }
    }
    transactions.set(transactionId, { ...record, status: 'redeemed' })
    codeHashIndex.delete(codeHash)

    if (record.codeExpiresAt === undefined || record.codeExpiresAt < now()) {
      return { ok: false, reason: 'invalid_grant' }
    }
    if (record.clientId !== input.clientId) {
      return { ok: false, reason: 'invalid_grant' }
    }
    if (record.redirectUri !== input.redirectUri) {
      return { ok: false, reason: 'redirect_uri_mismatch' }
    }
    if (!verifyPkce(record.codeChallenge, input.codeVerifier)) {
      return { ok: false, reason: 'pkce_verification_failed' }
    }

    return { ok: true, transactionId, scopes: record.scopes, clientId: record.clientId }
  }

  function mintAccessToken(
    scopes: readonly AuthScope[],
    _clientId: string,
  ): { accessToken: string; expiresIn: number } {
    // Opaque bearer token, not a JWT: validating it on protected routes is
    // a resource-server concern (oauth-resource-strategy.ts's seam) that
    // this slice does not wire up — see ADR-0005's "the resource-server
    // half does not already exist" constraint. This skeleton only mints
    // the token the /token response carries.
    const accessToken = randomBytes(32).toString('base64url')
    void scopes
    return { accessToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS }
  }

  return {
    createTransaction,
    approveTransaction,
    issueAuthorizationCode,
    redeemAuthorizationCode,
    mintAccessToken,
  }
}
