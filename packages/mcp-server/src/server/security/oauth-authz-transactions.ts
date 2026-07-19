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

// Bounds for the per-client /authorize attempt counter (slice B's rate
// limit on the GET before a transaction even exists). Values are
// deliberately generous for a human clicking through a consent screen,
// not tuned against a specific attacker model.
const RATE_LIMIT_MAX_ATTEMPTS = 10
const RATE_LIMIT_WINDOW_MS = 60_000

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
  // Double-submit CSRF binding for the approval POST (ADR-0005: "possession
  // of a transaction id must not authorize a cross-site POST"). The route
  // generates this value and never places it in a URL; the approval form
  // must echo it back alongside a matching cookie.
  csrfToken: z.string().min(1),
})

type CreateTransactionInput = z.infer<typeof createTransactionInputSchema>

type TransactionStatus = 'pending' | 'approved' | 'denied' | 'code-issued' | 'redeemed' | 'expired'

interface TransactionRecord {
  id: string
  clientId: string
  redirectUri: string
  scopes: readonly AuthScope[]
  state: string
  codeChallenge: string
  codeChallengeMethod: 'S256'
  csrfToken: string
  status: TransactionStatus
  createdAt: number
  expiresAt: number
  codeHash?: string
  codeExpiresAt?: number
}

const approvalViewSchema = z.object({
  clientId: z.string().min(1),
  redirectUri: z.string().min(1),
  scopes: z.array(z.enum(AUTH_SCOPES)),
  status: z.literal('pending'),
  expiresAt: z.number(),
})

export type ApprovalView = z.infer<typeof approvalViewSchema>

const redirectTargetSchema = z.object({
  clientId: z.string().min(1),
  redirectUri: z.string().min(1),
  state: z.string().min(1),
})

type RedirectTarget = z.infer<typeof redirectTargetSchema>

type RedeemAuthorizationCodeInput = {
  code: string
  clientId: string
  redirectUri: string
  codeVerifier: string | undefined
}

// What an access grant looks like to anything that is not the token holder:
// enough to render or revoke it, never enough to replay it. The raw token is
// absent by construction — only its SHA-256 hash is ever retained (RFC 6819
// §5.1.4.1.3: an authorization server should store credentials hashed so a
// dump of its state cannot be replayed against it), exactly as the
// authorization code already is.
const grantSummarySchema = z.object({
  grantId: z.string().min(1),
  clientId: z.string().min(1),
  scopes: z.array(z.enum(AUTH_SCOPES)),
  issuedAt: z.number(),
  expiresAt: z.number(),
})

type GrantSummary = z.infer<typeof grantSummarySchema>

// The authorization context a verified access token yields to the resource
// server. `scopes` is the set the *user approved for this grant* — never the
// full vocabulary — which is the whole point of the token being scoped at all.
const accessGrantContextSchema = z.object({
  grantId: z.string().min(1),
  clientId: z.string().min(1),
  scopes: z.array(z.enum(AUTH_SCOPES)),
})

type AccessGrantContext = z.infer<typeof accessGrantContextSchema>

interface GrantRecord {
  id: string
  clientId: string
  tokenHash: string
  scopes: readonly AuthScope[]
  issuedAt: number
  expiresAt: number
}

type RedeemAuthorizationCodeResult =
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

// Compare two secrets without leaking, through timing, how much of the
// value matched. timingSafeEqual throws on a length mismatch, so unequal
// lengths are rejected up front — a length difference is not itself secret.
function secretsMatch(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual)
  const expectedBytes = Buffer.from(expected)
  if (actualBytes.length !== expectedBytes.length) return false
  return timingSafeEqual(actualBytes, expectedBytes)
}

// S256 per RFC 7636 §4.2: challenge = BASE64URL-ENCODE(SHA256(verifier)).
function verifyPkce(codeChallenge: string, codeVerifier: string): boolean {
  const computedChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
  return secretsMatch(computedChallenge, codeChallenge)
}

export interface OAuthTransactionStore {
  createTransaction(input: CreateTransactionInput): { transactionId: string; expiresAt: number }
  approveTransaction(transactionId: string): boolean
  denyTransaction(transactionId: string): boolean
  issueAuthorizationCode(transactionId: string): { code: string } | null
  redeemAuthorizationCode(input: RedeemAuthorizationCodeInput): RedeemAuthorizationCodeResult
  // Mints the bearer token for an approved grant AND persists the grant it
  // authorizes. A token that is minted but not stored authorizes nothing — it
  // is a string the client believes in and the resource server has never
  // heard of.
  mintAccessToken(
    scopes: readonly AuthScope[],
    clientId: string,
  ): { accessToken: string; expiresIn: number }
  // Resource-server side of RFC 6749 §7: resolve a presented bearer to the
  // grant it belongs to, or null for anything unknown, expired, or revoked.
  // The caller learns nothing about *why* — see the middleware, which must
  // not let a caller distinguish credential kinds by their rejections.
  verifyAccessToken(accessToken: string): AccessGrantContext | null
  // RFC 7009's intent, without (yet) the /revoke endpoint: a grant a user
  // approved must be withdrawable. Returns false when the grant is already
  // gone, so a double-revoke is not reported as a fresh success.
  revokeGrant(grantId: string): boolean
  // Live, unexpired grants held by one client — the read side any future
  // grant-management surface needs, and the reason revocation is keyed by an
  // id rather than by a token nobody but the holder has.
  listGrants(clientId: string): readonly GrantSummary[]
  // Constant-time check that a submitted csrfToken is the one bound to the
  // transaction at creation.
  verifyApprovalBinding(transactionId: string, csrfToken: string): boolean
  // Read accessor for the approval screen. Deliberately narrower than
  // TransactionRecord: no state/codeChallenge/csrfToken/codeHash leak into
  // rendered HTML, and only a 'pending', unexpired transaction is
  // renderable at all — a screen cannot outlive its transaction.
  getTransactionForApproval(transactionId: string): ApprovalView | null
  // Where an authorization response for this transaction may be delivered,
  // and the `state` RFC 6749 §4.1.2 requires it to echo. Separate from
  // ApprovalView because that view feeds the rendered HTML and must not
  // carry `state`; this one feeds only a Location header. Pending-only, so
  // the decision route must read it *before* it approves or denies — a
  // transaction that has already been decided has no further response to
  // deliver.
  getTransactionRedirect(transactionId: string): RedirectTarget | null
  // Per-client sliding-window limiter for GET /authorize, gating attempts
  // before a transaction exists at all. Returns true when the attempt is
  // allowed (and is recorded), false when the client is over the limit.
  recordAuthorizeAttempt(clientId: string): boolean
  // Live entry counts. The store's only unbounded-growth risk is retained
  // dead records, so its occupancy has to be observable to be assertable.
  size(): { transactions: number; codes: number; attempts: number; grants: number }
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
  // Per-client sliding window of attempt timestamps for the /authorize
  // rate limit. Pruned lazily on every write, same posture as
  // pruneExpired, so it never needs a timer handle.
  const authorizeAttempts = new Map<string, number[]>()
  // Approved access grants, keyed by an opaque grant id so revocation has
  // something to name that is not the token itself. The token appears only as
  // the SHA-256 hash in `grantTokenIndex` / `GrantRecord.tokenHash`; the raw
  // value leaves this function once, in the /token response, and is never
  // retained.
  const grants = new Map<string, GrantRecord>()
  const grantTokenIndex = new Map<string, string>()

  // Lazy sweep, not a timer. A `setInterval` would keep the Node event loop
  // alive for the daemon's whole lifetime and would have to be torn down by
  // every construction site; sweeping on write bounds the maps by the same
  // TTL without owning a handle. A record past `expiresAt` can never again
  // be approved, code-issued, or redeemed (every transition re-checks it),
  // so dropping it is not observable to a caller — only its memory is.
  function pruneExpired(): void {
    const cutoff = now()
    for (const [id, record] of transactions) {
      if (record.expiresAt >= cutoff) continue
      transactions.delete(id)
      if (record.codeHash !== undefined) codeHashIndex.delete(record.codeHash)
    }
  }

  function createTransaction(input: CreateTransactionInput): {
    transactionId: string
    expiresAt: number
  } {
    pruneExpired()
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
      csrfToken: parsed.csrfToken,
      status: 'pending',
      createdAt,
      expiresAt,
    })
    return { transactionId: id, expiresAt }
  }

  // The only state a transaction can still be approved, denied, or rendered
  // from. Every caller below re-checks expiry here rather than trusting
  // pruneExpired to have run.
  function getPendingTransaction(transactionId: string): TransactionRecord | null {
    const record = transactions.get(transactionId)
    if (!record || record.status !== 'pending' || record.expiresAt < now()) return null
    return record
  }

  function decidePendingTransaction(transactionId: string, status: 'approved' | 'denied'): boolean {
    const record = getPendingTransaction(transactionId)
    if (!record) return false
    transactions.set(transactionId, { ...record, status })
    return true
  }

  function approveTransaction(transactionId: string): boolean {
    return decidePendingTransaction(transactionId, 'approved')
  }

  function denyTransaction(transactionId: string): boolean {
    return decidePendingTransaction(transactionId, 'denied')
  }

  function verifyApprovalBinding(transactionId: string, csrfToken: string): boolean {
    const record = transactions.get(transactionId)
    if (!record) return false
    return secretsMatch(csrfToken, record.csrfToken)
  }

  function getTransactionForApproval(transactionId: string): ApprovalView | null {
    const record = getPendingTransaction(transactionId)
    if (!record) return null
    return {
      clientId: record.clientId,
      redirectUri: record.redirectUri,
      scopes: [...record.scopes],
      status: 'pending',
      expiresAt: record.expiresAt,
    }
  }

  function getTransactionRedirect(transactionId: string): RedirectTarget | null {
    const record = getPendingTransaction(transactionId)
    if (!record) return null
    return { clientId: record.clientId, redirectUri: record.redirectUri, state: record.state }
  }

  function recordAuthorizeAttempt(clientId: string): boolean {
    const attemptedAt = now()
    const cutoff = attemptedAt - RATE_LIMIT_WINDOW_MS
    // Prune every client's window on each call, not just the current
    // client's, so an abandoned client's entry does not linger forever
    // just because nobody ever calls this again with its id.
    for (const [id, timestamps] of authorizeAttempts) {
      const live = timestamps.filter((t) => t > cutoff)
      if (live.length === 0) {
        authorizeAttempts.delete(id)
      } else if (live.length !== timestamps.length) {
        authorizeAttempts.set(id, live)
      }
    }

    const existing = authorizeAttempts.get(clientId) ?? []
    if (existing.length >= RATE_LIMIT_MAX_ATTEMPTS) return false
    authorizeAttempts.set(clientId, [...existing, attemptedAt])
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

  // Same lazy-sweep posture as pruneExpired, and for the same reason: a timer
  // would hold the event loop open for the daemon's whole life. An expired
  // grant is already unusable (verifyAccessToken re-checks expiry), so
  // reclaiming it is a memory concern, not a security one.
  function pruneExpiredGrants(): void {
    const cutoff = now()
    for (const [id, record] of grants) {
      if (record.expiresAt >= cutoff) continue
      grants.delete(id)
      grantTokenIndex.delete(record.tokenHash)
    }
  }

  function mintAccessToken(
    scopes: readonly AuthScope[],
    clientId: string,
  ): { accessToken: string; expiresIn: number } {
    pruneExpiredGrants()
    // Opaque bearer token, not a JWT: this daemon is both the authorization
    // server and the only resource server for its own API, so there is no
    // second party that would need to validate the token without asking us.
    // A local lookup against a hashed record is strictly less to get wrong
    // than signing keys, `alg` handling, and rotation.
    const accessToken = randomBytes(32).toString('base64url')
    const tokenHash = hashCode(accessToken)
    const issuedAt = now()
    const grantId = randomBytes(16).toString('base64url')
    grants.set(grantId, {
      id: grantId,
      clientId,
      tokenHash,
      scopes: [...scopes],
      issuedAt,
      expiresAt: issuedAt + ACCESS_TOKEN_TTL_SECONDS * 1000,
    })
    grantTokenIndex.set(tokenHash, grantId)
    return { accessToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS }
  }

  // A minted access token is a fixed-length base64url string (32 random
  // bytes). An input far longer than that is never a real token — bounding it
  // before hashing keeps a request from forcing the daemon to SHA-256 an
  // arbitrarily large body. The bound sits well above the real length so it
  // never rejects a legitimate token.
  const MAX_ACCESS_TOKEN_LENGTH = 256

  function verifyAccessToken(accessToken: string): AccessGrantContext | null {
    if (accessToken.length === 0 || accessToken.length > MAX_ACCESS_TOKEN_LENGTH) return null
    // Lookup is by hash of the presented token. The index maps a token hash to
    // its grant id, so a hit already means the stored hash equals this one —
    // there is no separate secret to compare, and a JS Map.get is not
    // constant-time anyway, so no digest comparison is done here. Expiry is
    // re-checked at use, not merely at issue.
    const presentedHash = hashCode(accessToken)
    const grantId = grantTokenIndex.get(presentedHash)
    if (grantId === undefined) return null
    const record = grants.get(grantId)
    if (!record) return null
    if (record.expiresAt < now()) return null
    return { grantId: record.id, clientId: record.clientId, scopes: [...record.scopes] }
  }

  function revokeGrant(grantId: string): boolean {
    pruneExpiredGrants()
    const record = grants.get(grantId)
    if (!record) return false
    grants.delete(grantId)
    grantTokenIndex.delete(record.tokenHash)
    return true
  }

  function listGrants(clientId: string): readonly GrantSummary[] {
    const cutoff = now()
    return [...grants.values()]
      .filter((record) => record.clientId === clientId && record.expiresAt >= cutoff)
      .map((record) => ({
        grantId: record.id,
        clientId: record.clientId,
        scopes: [...record.scopes],
        issuedAt: record.issuedAt,
        expiresAt: record.expiresAt,
      }))
  }

  function size(): { transactions: number; codes: number; attempts: number; grants: number } {
    return {
      transactions: transactions.size,
      codes: codeHashIndex.size,
      attempts: authorizeAttempts.size,
      grants: grants.size,
    }
  }

  return {
    createTransaction,
    approveTransaction,
    denyTransaction,
    issueAuthorizationCode,
    redeemAuthorizationCode,
    mintAccessToken,
    verifyAccessToken,
    revokeGrant,
    listGrants,
    verifyApprovalBinding,
    getTransactionForApproval,
    getTransactionRedirect,
    recordAuthorizeAttempt,
    size,
  }
}
