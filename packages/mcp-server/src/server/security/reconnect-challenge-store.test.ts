import { describe, expect, it } from 'vitest'
import { createReconnectChallengeStore } from './reconnect-challenge-store.js'

describe('createReconnectChallengeStore', () => {
  it('mints a challenge bound to the origin with a non-empty id and nonce', () => {
    const store = createReconnectChallengeStore()
    const minted = store.mintChallenge('https://example.test')
    expect(minted).not.toBeNull()
    expect(minted?.challengeId.length).toBeGreaterThan(0)
    expect(minted?.nonce.length).toBeGreaterThan(0)
    expect(minted?.expiresIn).toBe(60)
  })

  it('redeems a fresh challenge exactly once, returning the bound nonce', () => {
    const store = createReconnectChallengeStore()
    const minted = store.mintChallenge('https://example.test')
    if (!minted) throw new Error('expected mint to succeed')

    expect(store.redeemChallenge(minted.challengeId, 'https://example.test')).toBe(minted.nonce)
  })

  it('rejects a replayed challengeId on the second redemption (single-use)', () => {
    const store = createReconnectChallengeStore()
    const minted = store.mintChallenge('https://example.test')
    if (!minted) throw new Error('expected mint to succeed')

    expect(store.redeemChallenge(minted.challengeId, 'https://example.test')).not.toBeNull()
    expect(store.redeemChallenge(minted.challengeId, 'https://example.test')).toBeNull()
  })

  it('rejects redemption from a different origin than the one the challenge was minted for', () => {
    const store = createReconnectChallengeStore()
    const minted = store.mintChallenge('https://example.test')
    if (!minted) throw new Error('expected mint to succeed')

    expect(store.redeemChallenge(minted.challengeId, 'https://attacker.test')).toBeNull()
  })

  it('rejects an expired challenge', () => {
    let clock = 1_000_000
    const store = createReconnectChallengeStore({ now: () => clock })
    const minted = store.mintChallenge('https://example.test')
    if (!minted) throw new Error('expected mint to succeed')

    clock += 60_000 + 1
    expect(store.redeemChallenge(minted.challengeId, 'https://example.test')).toBeNull()
  })

  it('treats the exact expiry instant as still valid (inclusive boundary)', () => {
    let clock = 1_000_000
    const store = createReconnectChallengeStore({ now: () => clock })
    const minted = store.mintChallenge('https://example.test')
    if (!minted) throw new Error('expected mint to succeed')

    clock += 60_000 // exactly equal to expiresAt, not yet past it
    expect(store.redeemChallenge(minted.challengeId, 'https://example.test')).toBe(minted.nonce)
  })

  it('does not consume the legitimate challenge when redeemed with a mismatched origin, so the real client can still redeem it', () => {
    const store = createReconnectChallengeStore()
    const minted = store.mintChallenge('https://example.test')
    if (!minted) throw new Error('expected mint to succeed')

    expect(store.redeemChallenge(minted.challengeId, 'https://attacker.test')).toBeNull()
    expect(store.redeemChallenge(minted.challengeId, 'https://example.test')).toBe(minted.nonce)
  })

  it('mints challengeId and nonce as base64url-encoded 16-byte and 32-byte random values', () => {
    const store = createReconnectChallengeStore()
    const minted = store.mintChallenge('https://example.test')
    if (!minted) throw new Error('expected mint to succeed')

    const base64UrlPattern = /^[A-Za-z0-9_-]+$/
    expect(minted.challengeId).toMatch(base64UrlPattern)
    expect(minted.nonce).toMatch(base64UrlPattern)
    expect(Buffer.from(minted.challengeId, 'base64url')).toHaveLength(16)
    expect(Buffer.from(minted.nonce, 'base64url')).toHaveLength(32)
  })

  it('rejects a forged/garbage challengeId that was never minted', () => {
    const store = createReconnectChallengeStore()
    expect(store.redeemChallenge('not-a-real-id', 'https://example.test')).toBeNull()
  })

  it('lazily prunes expired challenges on the next mint, reclaiming memory', () => {
    let clock = 1_000_000
    const store = createReconnectChallengeStore({ now: () => clock })
    store.mintChallenge('https://example.test')
    expect(store.size()).toBe(1)

    clock += 60_000 + 1
    store.mintChallenge('https://example.test')

    expect(store.size()).toBe(1)
  })

  it('rejects minting past the hard cap of unexpired entries', () => {
    const store = createReconnectChallengeStore({ maxPending: 2 })
    expect(store.mintChallenge('https://example.test')).not.toBeNull()
    expect(store.mintChallenge('https://example.test')).not.toBeNull()
    expect(store.mintChallenge('https://example.test')).toBeNull()
    expect(store.size()).toBe(2)
  })

  it('resumes minting after expired entries are swept, even at the cap', () => {
    let clock = 1_000_000
    const store = createReconnectChallengeStore({ now: () => clock, maxPending: 1 })
    expect(store.mintChallenge('https://example.test')).not.toBeNull()
    expect(store.mintChallenge('https://example.test')).toBeNull()

    clock += 60_000 + 1
    expect(store.mintChallenge('https://example.test')).not.toBeNull()
  })
})
