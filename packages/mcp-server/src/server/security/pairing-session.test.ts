import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  computeS256Challenge,
  createPairingCodeStore,
  createPairingTokenStore,
  createSessionChallengeStore,
} from './pairing-session.js'

const ORIGIN = 'https://latest.kamiazya-whiteboard.pages.dev'

describe('pairing code store (single-use, PKCE-bound)', () => {
  it('redeems a fresh code exactly once', async () => {
    const store = createPairingCodeStore()
    const challenge = await computeS256Challenge('verifier-value')
    const code = store.mint({ origin: ORIGIN, codeChallenge: challenge })

    const redeemed = await store.redeem(code, 'verifier-value')
    expect(redeemed).toEqual({ origin: ORIGIN })
    // Single-use: the second redemption fails even with the right verifier.
    expect(await store.redeem(code, 'verifier-value')).toBeNull()
  })

  it('rejects a wrong PKCE verifier', async () => {
    const store = createPairingCodeStore()
    const code = store.mint({ origin: ORIGIN, codeChallenge: await computeS256Challenge('right') })
    expect(await store.redeem(code, 'wrong')).toBeNull()
    // A failed verifier burns the code — no second guess.
    expect(await store.redeem(code, 'right')).toBeNull()
  })

  it('rejects an expired code', async () => {
    const store = createPairingCodeStore({ ttlMs: 0 })
    const code = store.mint({ origin: ORIGIN, codeChallenge: await computeS256Challenge('v') })
    await new Promise((r) => setTimeout(r, 5))
    expect(await store.redeem(code, 'v')).toBeNull()
  })

  it('rejects an unknown code', async () => {
    const store = createPairingCodeStore()
    expect(await store.redeem('nope', 'v')).toBeNull()
  })
})

describe('pairing token store (memory-only session tokens)', () => {
  it('mints an origin-scoped token and validates it against that origin only', () => {
    const store = createPairingTokenStore()
    const { token, expiresAt } = store.mint(ORIGIN)
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now())
    expect(store.validate(token, ORIGIN)).toBe(true)
    expect(store.validate(token, 'https://other.example.com')).toBe(false)
    expect(store.validate('wrong-token', ORIGIN)).toBe(false)
  })

  it('rejects an expired token', async () => {
    const store = createPairingTokenStore({ ttlMs: 0 })
    const { token } = store.mint(ORIGIN)
    await new Promise((r) => setTimeout(r, 5))
    expect(store.validate(token, ORIGIN)).toBe(false)
  })

  it('revokeOrigin kills every token for that origin (grant revocation path)', () => {
    const store = createPairingTokenStore()
    const a = store.mint(ORIGIN)
    const b = store.mint(ORIGIN)
    const other = store.mint('https://other.example.com')
    store.revokeOrigin(ORIGIN)
    expect(store.validate(a.token, ORIGIN)).toBe(false)
    expect(store.validate(b.token, ORIGIN)).toBe(false)
    expect(store.validate(other.token, 'https://other.example.com')).toBe(true)
  })
})

const CREDENTIAL_A = { origin: ORIGIN, credentialId: 'cred-a' }
const CREDENTIAL_B = { origin: ORIGIN, credentialId: 'cred-b' }

describe('pairing token store — passkey binding', () => {
  it('bind then bindingOf answers the binding for the right origin, and null for another origin', () => {
    const store = createPairingTokenStore()
    const { token } = store.mint(ORIGIN)
    expect(store.bind(token, CREDENTIAL_A)).not.toBeNull()
    expect(store.bindingOf(token, ORIGIN)).toEqual(CREDENTIAL_A)
    expect(store.bindingOf(token, 'https://other.example.com')).toBeNull()
  })

  it('bindingOf answers null for an unknown token and for an unbound one', () => {
    const store = createPairingTokenStore()
    const { token } = store.mint(ORIGIN)
    expect(store.bindingOf('unknown-token', ORIGIN)).toBeNull()
    expect(store.bindingOf(token, ORIGIN)).toBeNull()
  })

  it('bind on an unknown or expired token answers null and binds nothing', () => {
    const store = createPairingTokenStore({ ttlMs: 1000 })
    const { token } = store.mint(ORIGIN)
    vi.useFakeTimers()
    try {
      vi.setSystemTime(Date.now() + 1001)
      expect(store.bind(token, CREDENTIAL_A)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
    expect(store.bind('never-minted', CREDENTIAL_A)).toBeNull()
  })

  it('revokeBoundTo returns the count and kills only tokens bound to a matching pair', () => {
    const store = createPairingTokenStore()
    const bound = store.mint(ORIGIN)
    const otherCredential = store.mint(ORIGIN)
    const unbound = store.mint(ORIGIN)
    store.bind(bound.token, CREDENTIAL_A)
    store.bind(otherCredential.token, CREDENTIAL_B)

    expect(store.revokeBoundTo([CREDENTIAL_A])).toBe(1)
    expect(store.validate(bound.token, ORIGIN)).toBe(false)
    // A sibling bound to a different credential survives.
    expect(store.validate(otherCredential.token, ORIGIN)).toBe(true)
    // An unbound token is untouched by a credential-scoped revoke.
    expect(store.validate(unbound.token, ORIGIN)).toBe(true)
  })

  it('revokeOrigin still kills bound and unbound tokens alike', () => {
    const store = createPairingTokenStore()
    const bound = store.mint(ORIGIN)
    const unbound = store.mint(ORIGIN)
    store.bind(bound.token, CREDENTIAL_A)
    store.revokeOrigin(ORIGIN)
    expect(store.validate(bound.token, ORIGIN)).toBe(false)
    expect(store.validate(unbound.token, ORIGIN)).toBe(false)
  })
})

describe('session challenge store (single-use, session-scoped)', () => {
  it('mints a 43-char base64url challenge and redeems the same bytes exactly once', () => {
    const store = createSessionChallengeStore()
    const { challenge } = store.mint('token-a')
    expect(challenge).toHaveLength(43)
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/)

    const redeemed = store.redeem('token-a')
    expect(redeemed).not.toBeNull()
    expect(Buffer.from(redeemed ?? new Uint8Array()).toString('base64url')).toBe(challenge)
    // Single-use: a second redemption of the same mint answers null.
    expect(store.redeem('token-a')).toBeNull()
  })

  it('redeem for a token that never minted answers null', () => {
    const store = createSessionChallengeStore()
    expect(store.redeem('never-minted')).toBeNull()
  })

  it('a challenge minted for token A is refused for token B', () => {
    const store = createSessionChallengeStore()
    store.mint('token-a')
    expect(store.redeem('token-b')).toBeNull()
    // The original mint is still live — token B could not spend it.
    expect(store.redeem('token-a')).not.toBeNull()
  })

  it('a second mint for the same token replaces the first', () => {
    const store = createSessionChallengeStore()
    const first = store.mint('token-a')
    const second = store.mint('token-a')
    expect(second.challenge).not.toBe(first.challenge)
    const redeemed = store.redeem('token-a')
    expect(Buffer.from(redeemed ?? new Uint8Array()).toString('base64url')).toBe(second.challenge)
  })

  describe('TTL expiry', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('rejects a challenge redeemed after its TTL', () => {
      const store = createSessionChallengeStore({ ttlMs: 60_000 })
      store.mint('token-a')
      vi.setSystemTime(Date.now() + 60_001)
      expect(store.redeem('token-a')).toBeNull()
    })
  })
})
