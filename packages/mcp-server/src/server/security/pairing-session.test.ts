import { describe, expect, it } from 'vitest'
import {
  computeS256Challenge,
  createPairingCodeStore,
  createPairingTokenStore,
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
