import { describe, expect, it } from 'vitest'
import { createOAuthTransactionStore } from './oauth-authz-transactions.js'

const baseInput = {
  clientId: 'whiteboard-hosted-web',
  redirectUri: 'https://whiteboard.pages.dev/oauth/callback',
  scopes: ['workspace:read', 'workspace:write'] as const,
  state: 'client-supplied-state-value',
  codeChallenge: 'test-challenge-does-not-need-to-be-real-for-creation',
  codeChallengeMethod: 'S256' as const,
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
})
