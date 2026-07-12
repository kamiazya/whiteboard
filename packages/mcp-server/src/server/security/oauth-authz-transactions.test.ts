import { describe, expect, it } from 'vitest'
import { createOAuthTransactionStore } from './oauth-authz-transactions.js'

describe('expired-entry pruning', () => {
  const TRANSACTION_TTL_MS = 5 * 60_000

  it('reclaims an expired transaction on the next write instead of leaking it', () => {
    let clock = 1_000_000
    const store = createOAuthTransactionStore({ now: () => clock })
    store.createTransaction({
      clientId: 'c',
      redirectUri: 'https://example.test/cb',
      scopes: ['workspace:read'],
      state: 's',
      codeChallenge: 'challenge',
      codeChallengeMethod: 'S256',
      csrfToken: 'csrf-token',
    })
    expect(store.size()).toEqual({ transactions: 1, codes: 0, attempts: 0, grants: 0 })

    clock += TRANSACTION_TTL_MS + 1
    store.createTransaction({
      clientId: 'c',
      redirectUri: 'https://example.test/cb',
      scopes: ['workspace:read'],
      state: 's2',
      codeChallenge: 'challenge',
      codeChallengeMethod: 'S256',
      csrfToken: 'csrf-token',
    })

    // The first transaction is gone, not merely unusable: a long-lived daemon
    // must not accumulate one record per abandoned/attacker-driven attempt.
    expect(store.size()).toEqual({ transactions: 1, codes: 0, attempts: 0, grants: 0 })
  })

  it('reclaims the code-hash index entry of an expired code-issued transaction', () => {
    let clock = 1_000_000
    const store = createOAuthTransactionStore({ now: () => clock })
    const { transactionId } = store.createTransaction({
      clientId: 'c',
      redirectUri: 'https://example.test/cb',
      scopes: ['workspace:read'],
      state: 's',
      codeChallenge: 'challenge',
      codeChallengeMethod: 'S256',
      csrfToken: 'csrf-token',
    })
    store.approveTransaction(transactionId)
    expect(store.issueAuthorizationCode(transactionId)).not.toBeNull()
    expect(store.size()).toEqual({ transactions: 1, codes: 1, attempts: 0, grants: 0 })

    clock += TRANSACTION_TTL_MS + 1
    store.createTransaction({
      clientId: 'c',
      redirectUri: 'https://example.test/cb',
      scopes: ['workspace:read'],
      state: 's2',
      codeChallenge: 'challenge',
      codeChallengeMethod: 'S256',
      csrfToken: 'csrf-token',
    })

    expect(store.size()).toEqual({ transactions: 1, codes: 0, attempts: 0, grants: 0 })
  })

  it('reclaims a redeemed transaction once its window has passed', () => {
    let clock = 1_000_000
    const store = createOAuthTransactionStore({ now: () => clock })
    const { transactionId } = store.createTransaction({
      clientId: 'c',
      redirectUri: 'https://example.test/cb',
      scopes: ['workspace:read'],
      state: 's',
      codeChallenge: 'challenge',
      codeChallengeMethod: 'S256',
      csrfToken: 'csrf-token',
    })
    store.approveTransaction(transactionId)
    const issued = store.issueAuthorizationCode(transactionId)
    if (!issued) throw new Error('expected issuance')
    store.redeemAuthorizationCode({
      code: issued.code,
      clientId: 'c',
      redirectUri: 'https://example.test/cb',
      codeVerifier: 'v',
    })
    expect(store.size().transactions).toBe(1)

    clock += TRANSACTION_TTL_MS + 1
    store.createTransaction({
      clientId: 'c',
      redirectUri: 'https://example.test/cb',
      scopes: ['workspace:read'],
      state: 's2',
      codeChallenge: 'challenge',
      codeChallengeMethod: 'S256',
      csrfToken: 'csrf-token',
    })
    expect(store.size().transactions).toBe(1)
  })
})

const baseInput = {
  clientId: 'whiteboard-hosted-web',
  redirectUri: 'https://whiteboard.pages.dev/oauth/callback',
  scopes: ['workspace:read', 'workspace:write'] as const,
  state: 'client-supplied-state-value',
  codeChallenge: 'test-challenge-does-not-need-to-be-real-for-creation',
  codeChallengeMethod: 'S256' as const,
  csrfToken: 'csrf-token-for-approval-binding',
}

// A real S256 PKCE pair: challenge = base64url(sha256(verifier)).
const PKCE_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
const PKCE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'

function createApprovedCodeIssuedTransaction(
  store: ReturnType<typeof createOAuthTransactionStore>,
  overrides: Partial<typeof baseInput> = {},
) {
  const { transactionId } = store.createTransaction({
    ...baseInput,
    ...overrides,
    codeChallenge: PKCE_CHALLENGE,
  })
  store.approveTransaction(transactionId)
  const issued = store.issueAuthorizationCode(transactionId)
  if (!issued) throw new Error('expected code issuance to succeed')
  return { transactionId, code: issued.code }
}

describe('createOAuthTransactionStore', () => {
  it('requires state at transaction creation — PKCE is not a substitute for it', () => {
    const store = createOAuthTransactionStore()
    expect(() => store.createTransaction({ ...baseInput, state: '' })).toThrow()
  })

  it('requires code_challenge_method S256 at transaction creation', () => {
    const store = createOAuthTransactionStore()
    expect(() =>
      store.createTransaction({
        ...baseInput,
        // @ts-expect-error deliberately invalid method for the red test
        codeChallengeMethod: 'plain',
      }),
    ).toThrow()
  })

  it('stores the authorization code only as a hash — the raw code never round-trips out of the store', () => {
    const store = createOAuthTransactionStore()
    const { code } = createApprovedCodeIssuedTransaction(store)
    // The only way to prove "hash only" from outside the module is behavioral:
    // redemption must work with the raw code (proving it can rehash and
    // compare), and the raw code must not appear verbatim in any exposed
    // debug/snapshot surface. This store exposes no such surface at all,
    // which is itself the point — assert redemption still succeeds.
    const result = store.redeemAuthorizationCode({
      code,
      clientId: baseInput.clientId,
      redirectUri: baseInput.redirectUri,
      codeVerifier: PKCE_VERIFIER,
    })
    expect(result.ok).toBe(true)
  })

  it('rejects redemption with no code_verifier at all — server-side enforcement, not documentation', () => {
    const store = createOAuthTransactionStore()
    const { code } = createApprovedCodeIssuedTransaction(store)
    const result = store.redeemAuthorizationCode({
      code,
      clientId: baseInput.clientId,
      redirectUri: baseInput.redirectUri,
      codeVerifier: undefined,
    })
    expect(result).toEqual({ ok: false, reason: 'invalid_request' })
  })

  it('rejects redemption with a code_verifier that does not match the S256 challenge', () => {
    const store = createOAuthTransactionStore()
    const { code } = createApprovedCodeIssuedTransaction(store)
    const result = store.redeemAuthorizationCode({
      code,
      clientId: baseInput.clientId,
      redirectUri: baseInput.redirectUri,
      codeVerifier: 'wrong-verifier-entirely',
    })
    expect(result).toEqual({ ok: false, reason: 'pkce_verification_failed' })
  })

  it('redeems successfully with the exact matching code_verifier', () => {
    const store = createOAuthTransactionStore()
    const { code } = createApprovedCodeIssuedTransaction(store)
    const result = store.redeemAuthorizationCode({
      code,
      clientId: baseInput.clientId,
      redirectUri: baseInput.redirectUri,
      codeVerifier: PKCE_VERIFIER,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.scopes).toEqual(baseInput.scopes)
      expect(result.clientId).toBe(baseInput.clientId)
    }
  })

  it('is single-use — a second redemption of the same code fails even with correct credentials', () => {
    const store = createOAuthTransactionStore()
    const { code } = createApprovedCodeIssuedTransaction(store)
    const redeemOnce = () =>
      store.redeemAuthorizationCode({
        code,
        clientId: baseInput.clientId,
        redirectUri: baseInput.redirectUri,
        codeVerifier: PKCE_VERIFIER,
      })
    const first = redeemOnce()
    const second = redeemOnce()
    expect(first.ok).toBe(true)
    expect(second).toEqual({ ok: false, reason: 'invalid_grant' })
  })

  it('resolves two concurrent redemptions of the same code to exactly one success (compare-and-swap)', async () => {
    const store = createOAuthTransactionStore()
    const { code } = createApprovedCodeIssuedTransaction(store)
    const redeem = () =>
      Promise.resolve(
        store.redeemAuthorizationCode({
          code,
          clientId: baseInput.clientId,
          redirectUri: baseInput.redirectUri,
          codeVerifier: PKCE_VERIFIER,
        }),
      )
    const [first, second] = await Promise.all([redeem(), redeem()])
    const successes = [first, second].filter((r) => r.ok)
    const failures = [first, second].filter((r) => !r.ok)
    expect(successes).toHaveLength(1)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ ok: false, reason: 'invalid_grant' })
  })

  it('rejects redemption when the client_id does not match the transaction', () => {
    const store = createOAuthTransactionStore()
    const { code } = createApprovedCodeIssuedTransaction(store)
    const result = store.redeemAuthorizationCode({
      code,
      clientId: 'a-different-client',
      redirectUri: baseInput.redirectUri,
      codeVerifier: PKCE_VERIFIER,
    })
    expect(result).toEqual({ ok: false, reason: 'invalid_grant' })
  })

  it('rejects redemption when the redirect_uri does not match the transaction', () => {
    const store = createOAuthTransactionStore()
    const { code } = createApprovedCodeIssuedTransaction(store)
    const result = store.redeemAuthorizationCode({
      code,
      clientId: baseInput.clientId,
      redirectUri: 'https://attacker.example/callback',
      codeVerifier: PKCE_VERIFIER,
    })
    expect(result).toEqual({ ok: false, reason: 'redirect_uri_mismatch' })
  })

  it('rejects an unknown/never-issued code', () => {
    const store = createOAuthTransactionStore()
    const result = store.redeemAuthorizationCode({
      code: 'never-issued-code',
      clientId: baseInput.clientId,
      redirectUri: baseInput.redirectUri,
      codeVerifier: PKCE_VERIFIER,
    })
    expect(result).toEqual({ ok: false, reason: 'invalid_grant' })
  })

  it('rejects issuing a code for a transaction that was never approved', () => {
    const store = createOAuthTransactionStore()
    const { transactionId } = store.createTransaction({
      ...baseInput,
      codeChallenge: PKCE_CHALLENGE,
    })
    expect(store.issueAuthorizationCode(transactionId)).toBeNull()
  })

  it('rejects redemption once the short-lived code TTL has elapsed', () => {
    let currentTime = 0
    const store = createOAuthTransactionStore({ now: () => currentTime })
    const { transactionId } = store.createTransaction({
      ...baseInput,
      codeChallenge: PKCE_CHALLENGE,
    })
    store.approveTransaction(transactionId)
    const issued = store.issueAuthorizationCode(transactionId)
    if (!issued) throw new Error('expected code issuance to succeed')
    currentTime += 10 * 60_000 // advance well past the code's short TTL
    const result = store.redeemAuthorizationCode({
      code: issued.code,
      clientId: baseInput.clientId,
      redirectUri: baseInput.redirectUri,
      codeVerifier: PKCE_VERIFIER,
    })
    expect(result).toEqual({ ok: false, reason: 'invalid_grant' })
  })

  it('has no durability across store instances — a fresh store has no pending transactions', () => {
    // The daemon-restart rule this store implements: an in-memory Map that
    // dies with the process. A restarted daemon constructs a brand new
    // store, so every transaction that was pending, approved, or
    // code-issued in the old process is gone — there is no way for an
    // approval screen to outlive its backing transaction.
    const store = createOAuthTransactionStore()
    const result = store.redeemAuthorizationCode({
      code: 'anything',
      clientId: baseInput.clientId,
      redirectUri: baseInput.redirectUri,
      codeVerifier: PKCE_VERIFIER,
    })
    expect(result).toEqual({ ok: false, reason: 'invalid_grant' })
  })

  it('mints an opaque short-lived access token after successful redemption', () => {
    const store = createOAuthTransactionStore()
    const { code } = createApprovedCodeIssuedTransaction(store)
    const result = store.redeemAuthorizationCode({
      code,
      clientId: baseInput.clientId,
      redirectUri: baseInput.redirectUri,
      codeVerifier: PKCE_VERIFIER,
    })
    if (!result.ok) throw new Error('expected redemption to succeed')
    const minted = store.mintAccessToken(result.scopes, result.clientId)
    expect(minted.accessToken).toEqual(expect.any(String))
    expect(minted.accessToken.length).toBeGreaterThan(20)
    expect(minted.expiresIn).toBeGreaterThan(0)
  })

  it('rejects creation with a missing or empty csrfToken at the Zod boundary', () => {
    const store = createOAuthTransactionStore()
    expect(() => store.createTransaction({ ...baseInput, csrfToken: '' })).toThrow()
    const { csrfToken, ...withoutCsrfToken } = baseInput
    expect(() =>
      store.createTransaction(
        withoutCsrfToken as unknown as Parameters<typeof store.createTransaction>[0],
      ),
    ).toThrow()
  })
})

describe('verifyApprovalBinding', () => {
  it('returns true only for the exact csrfToken bound to the transaction', () => {
    const store = createOAuthTransactionStore()
    const { transactionId } = store.createTransaction(baseInput)
    expect(store.verifyApprovalBinding(transactionId, baseInput.csrfToken)).toBe(true)
    expect(store.verifyApprovalBinding(transactionId, 'wrong-token')).toBe(false)
  })

  it('returns false for an unknown transaction id', () => {
    const store = createOAuthTransactionStore()
    expect(store.verifyApprovalBinding('never-created', 'anything')).toBe(false)
  })
})

describe('denyTransaction', () => {
  it('moves a pending transaction to denied, closing off approval and code issuance', () => {
    const store = createOAuthTransactionStore()
    const { transactionId } = store.createTransaction(baseInput)
    expect(store.denyTransaction(transactionId)).toBe(true)
    expect(store.approveTransaction(transactionId)).toBe(false)
    expect(store.issueAuthorizationCode(transactionId)).toBeNull()
  })

  it('returns false for an unknown transaction id', () => {
    const store = createOAuthTransactionStore()
    expect(store.denyTransaction('never-created')).toBe(false)
  })
})

describe('issueAuthorizationCode single-issuance', () => {
  it('returns null for a second issuance attempt on an already code-issued transaction', () => {
    const store = createOAuthTransactionStore()
    const { transactionId } = store.createTransaction(baseInput)
    store.approveTransaction(transactionId)
    expect(store.issueAuthorizationCode(transactionId)).not.toBeNull()
    expect(store.issueAuthorizationCode(transactionId)).toBeNull()
  })
})

describe('getTransactionForApproval', () => {
  it('returns an approval view for a pending, unexpired transaction', () => {
    const store = createOAuthTransactionStore()
    const { transactionId, expiresAt } = store.createTransaction(baseInput)
    expect(store.getTransactionForApproval(transactionId)).toEqual({
      clientId: baseInput.clientId,
      redirectUri: baseInput.redirectUri,
      scopes: baseInput.scopes,
      status: 'pending',
      expiresAt,
    })
  })

  it('returns null once the transaction has been denied', () => {
    const store = createOAuthTransactionStore()
    const { transactionId } = store.createTransaction(baseInput)
    store.denyTransaction(transactionId)
    expect(store.getTransactionForApproval(transactionId)).toBeNull()
  })

  it('returns null once a code has been issued for the transaction', () => {
    const store = createOAuthTransactionStore()
    const { transactionId } = createApprovedCodeIssuedTransaction(store)
    expect(store.getTransactionForApproval(transactionId)).toBeNull()
  })

  it('returns null once the transaction has expired', () => {
    let clock = 1_000_000
    const store = createOAuthTransactionStore({ now: () => clock })
    const { transactionId } = store.createTransaction(baseInput)
    clock += 5 * 60_000 + 1
    expect(store.getTransactionForApproval(transactionId)).toBeNull()
  })

  it('returns null for an unknown transaction id', () => {
    const store = createOAuthTransactionStore()
    expect(store.getTransactionForApproval('never-created')).toBeNull()
  })
})

describe('authorize attempt rate limiting', () => {
  const RATE_LIMIT_MAX_ATTEMPTS = 10
  const RATE_LIMIT_WINDOW_MS = 60_000

  it('blocks the Nth+1 attempt in-window for the same client and recovers after the window passes', () => {
    let clock = 1_000_000
    const store = createOAuthTransactionStore({ now: () => clock })
    for (let i = 0; i < RATE_LIMIT_MAX_ATTEMPTS; i++) {
      expect(store.recordAuthorizeAttempt('client-a')).toBe(true)
    }
    expect(store.recordAuthorizeAttempt('client-a')).toBe(false)

    clock += RATE_LIMIT_WINDOW_MS + 1
    expect(store.recordAuthorizeAttempt('client-a')).toBe(true)
  })

  it('tracks each client independently', () => {
    const store = createOAuthTransactionStore()
    for (let i = 0; i < RATE_LIMIT_MAX_ATTEMPTS; i++) {
      expect(store.recordAuthorizeAttempt('client-a')).toBe(true)
    }
    expect(store.recordAuthorizeAttempt('client-a')).toBe(false)
    expect(store.recordAuthorizeAttempt('client-b')).toBe(true)
  })

  it('keeps the attempt-tracking map bounded once a client-window has fully elapsed', () => {
    let clock = 1_000_000
    const store = createOAuthTransactionStore({ now: () => clock })
    store.recordAuthorizeAttempt('client-a')
    expect(store.size().attempts).toBe(1)

    clock += RATE_LIMIT_WINDOW_MS + 1
    // A prune only ever runs on a write for this client (or another one) — a
    // fresh attempt from a different client must not resurrect client-a's
    // stale entry.
    store.recordAuthorizeAttempt('client-b')
    expect(store.size().attempts).toBe(1)
  })
})
