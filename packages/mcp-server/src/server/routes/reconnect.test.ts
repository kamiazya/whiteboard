import { webcrypto } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EcP256PublicJwk } from '../../shared/api-contracts/reconnect.js'
import { createReconnectChallengeStore } from '../security/reconnect-challenge-store.js'
import { createWebOriginTrustStore } from '../security/web-origin-trust-store.js'
import { createReconnectRouter } from './reconnect.js'

async function generateKeyPair(): Promise<{
  publicJwk: EcP256PublicJwk
  privateKey: webcrypto.CryptoKey
}> {
  const keyPair = (await webcrypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )) as webcrypto.CryptoKeyPair
  const exported = (await webcrypto.subtle.exportKey('jwk', keyPair.publicKey)) as JsonWebKey
  const publicJwk: EcP256PublicJwk = {
    kty: 'EC',
    crv: 'P-256',
    x: exported.x as string,
    y: exported.y as string,
  }
  return { publicJwk, privateKey: keyPair.privateKey }
}

async function signNonce(privateKey: webcrypto.CryptoKey, nonce: string): Promise<string> {
  const signature = await webcrypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(nonce),
  )
  return Buffer.from(signature).toString('base64url')
}

describe('reconnect routes', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'whiteboard-reconnect-route-'))
  })

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  describe('POST /api/reconnect-credential', () => {
    it('enrolls a public key for an allowlisted origin', async () => {
      const trustStore = createWebOriginTrustStore({ dataDir })
      const app = createReconnectRouter({
        trustStore,
        challengeStore: createReconnectChallengeStore(),
        allowedWebOrigins: ['http://localhost:5173'],
        daemonToken: 'daemon-token-value',
      })
      const { publicJwk } = await generateKeyPair()

      const res = await app.request('/api/reconnect-credential', {
        method: 'POST',
        headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' },
        body: JSON.stringify({ publicKeyJwk: publicJwk }),
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({ credentialKind: 'publicKey', expiresInDays: 30 })

      const records = await trustStore.list()
      expect(records[0]?.publicKeyJwk).toEqual(publicJwk)
    })

    it('rejects a JWK with a "d" (private-key) field present — strict schema', async () => {
      const trustStore = createWebOriginTrustStore({ dataDir })
      const app = createReconnectRouter({
        trustStore,
        challengeStore: createReconnectChallengeStore(),
        allowedWebOrigins: ['http://localhost:5173'],
        daemonToken: 'daemon-token-value',
      })
      const { publicJwk } = await generateKeyPair()

      const res = await app.request('/api/reconnect-credential', {
        method: 'POST',
        headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' },
        body: JSON.stringify({ publicKeyJwk: { ...publicJwk, d: 'private-key-leak' } }),
      })

      expect(res.status).toBe(400)
    })

    it('rejects a JWK with extra fields (ext/key_ops) — strict schema', async () => {
      const trustStore = createWebOriginTrustStore({ dataDir })
      const app = createReconnectRouter({
        trustStore,
        challengeStore: createReconnectChallengeStore(),
        allowedWebOrigins: ['http://localhost:5173'],
        daemonToken: 'daemon-token-value',
      })
      const { publicJwk } = await generateKeyPair()

      const res = await app.request('/api/reconnect-credential', {
        method: 'POST',
        headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' },
        body: JSON.stringify({ publicKeyJwk: { ...publicJwk, ext: true, key_ops: ['verify'] } }),
      })

      expect(res.status).toBe(400)
    })

    it('rejects a JWK with the wrong curve', async () => {
      const trustStore = createWebOriginTrustStore({ dataDir })
      const app = createReconnectRouter({
        trustStore,
        challengeStore: createReconnectChallengeStore(),
        allowedWebOrigins: ['http://localhost:5173'],
        daemonToken: 'daemon-token-value',
      })
      const { publicJwk } = await generateKeyPair()

      const res = await app.request('/api/reconnect-credential', {
        method: 'POST',
        headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' },
        body: JSON.stringify({ publicKeyJwk: { ...publicJwk, crv: 'P-384' } }),
      })

      expect(res.status).toBe(400)
    })

    it('rejects a JWK whose x/y do not decode to 32 bytes', async () => {
      const trustStore = createWebOriginTrustStore({ dataDir })
      const app = createReconnectRouter({
        trustStore,
        challengeStore: createReconnectChallengeStore(),
        allowedWebOrigins: ['http://localhost:5173'],
        daemonToken: 'daemon-token-value',
      })
      const { publicJwk } = await generateKeyPair()

      const res = await app.request('/api/reconnect-credential', {
        method: 'POST',
        headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' },
        body: JSON.stringify({ publicKeyJwk: { ...publicJwk, x: 'dG9vLXNob3J0' } }),
      })

      expect(res.status).toBe(400)
    })

    it('403s an origin that is not on the allowlist', async () => {
      const trustStore = createWebOriginTrustStore({ dataDir })
      const app = createReconnectRouter({
        trustStore,
        challengeStore: createReconnectChallengeStore(),
        allowedWebOrigins: ['http://localhost:5173'],
        daemonToken: 'daemon-token-value',
      })
      const { publicJwk } = await generateKeyPair()

      const res = await app.request('/api/reconnect-credential', {
        method: 'POST',
        headers: { origin: 'http://evil.example.com', 'content-type': 'application/json' },
        body: JSON.stringify({ publicKeyJwk: publicJwk }),
      })

      expect(res.status).toBe(403)
    })

    it('403s when no Origin header is present', async () => {
      const trustStore = createWebOriginTrustStore({ dataDir })
      const app = createReconnectRouter({
        trustStore,
        challengeStore: createReconnectChallengeStore(),
        allowedWebOrigins: ['http://localhost:5173'],
        daemonToken: 'daemon-token-value',
      })

      const res = await app.request('/api/reconnect-credential', { method: 'POST' })
      expect(res.status).toBe(403)
    })
  })

  describe('POST /api/reconnect-challenge', () => {
    it('mints a challenge for an admitted origin', async () => {
      const app = createReconnectRouter({
        trustStore: createWebOriginTrustStore({ dataDir }),
        challengeStore: createReconnectChallengeStore(),
        allowedWebOrigins: ['http://localhost:5173'],
        daemonToken: 'daemon-token-value',
      })

      const res = await app.request('/api/reconnect-challenge', {
        method: 'POST',
        headers: { origin: 'http://localhost:5173' },
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({
        challengeId: expect.any(String),
        nonce: expect.any(String),
        expiresInSeconds: expect.any(Number),
      })
    })

    it('mints a challenge even when the origin has no enrolled credential (no enrollment oracle)', async () => {
      const app = createReconnectRouter({
        trustStore: createWebOriginTrustStore({ dataDir }),
        challengeStore: createReconnectChallengeStore(),
        allowedWebOrigins: ['http://localhost:5173'],
        daemonToken: 'daemon-token-value',
      })

      const res = await app.request('/api/reconnect-challenge', {
        method: 'POST',
        headers: { origin: 'http://localhost:5173' },
      })
      expect(res.status).toBe(200)
    })

    it('403s an origin that is not admitted', async () => {
      const app = createReconnectRouter({
        trustStore: createWebOriginTrustStore({ dataDir }),
        challengeStore: createReconnectChallengeStore(),
        allowedWebOrigins: ['http://localhost:5173'],
        daemonToken: 'daemon-token-value',
      })

      const res = await app.request('/api/reconnect-challenge', {
        method: 'POST',
        headers: { origin: 'http://evil.example.com' },
      })
      expect(res.status).toBe(403)
    })

    it('429s once the pending-challenge cap is exceeded', async () => {
      const challengeStore = createReconnectChallengeStore({ maxPending: 1 })
      const app = createReconnectRouter({
        trustStore: createWebOriginTrustStore({ dataDir }),
        challengeStore,
        allowedWebOrigins: ['http://localhost:5173'],
        daemonToken: 'daemon-token-value',
      })

      const first = await app.request('/api/reconnect-challenge', {
        method: 'POST',
        headers: { origin: 'http://localhost:5173' },
      })
      expect(first.status).toBe(200)

      const second = await app.request('/api/reconnect-challenge', {
        method: 'POST',
        headers: { origin: 'http://localhost:5173' },
      })
      expect(second.status).toBe(429)
    })
  })

  describe('POST /api/reconnect-session — signed challenge path', () => {
    async function enrollAndChallenge(origin: string) {
      const trustStore = createWebOriginTrustStore({ dataDir })
      const challengeStore = createReconnectChallengeStore()
      const { publicJwk, privateKey } = await generateKeyPair()
      await trustStore.enrollPublicKey(origin, publicJwk)
      return { trustStore, challengeStore, publicJwk, privateKey }
    }

    it('returns the daemon token for a valid signature over a fresh challenge', async () => {
      const origin = 'http://localhost:5173'
      const { trustStore, challengeStore, privateKey } = await enrollAndChallenge(origin)
      const app = createReconnectRouter({
        trustStore,
        challengeStore,
        allowedWebOrigins: [origin],
        daemonToken: 'daemon-token-value',
      })

      const minted = challengeStore.mintChallenge(origin)
      if (minted === null) throw new Error('expected a minted challenge')
      const signature = await signNonce(privateKey, minted.nonce)

      const res = await app.request('/api/reconnect-session', {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ challengeId: minted.challengeId, signature }),
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({ token: 'daemon-token-value' })
    })

    it('403s a replayed challengeId', async () => {
      const origin = 'http://localhost:5173'
      const { trustStore, challengeStore, privateKey } = await enrollAndChallenge(origin)
      const app = createReconnectRouter({
        trustStore,
        challengeStore,
        allowedWebOrigins: [origin],
        daemonToken: 'daemon-token-value',
      })

      const minted = challengeStore.mintChallenge(origin)
      if (minted === null) throw new Error('expected a minted challenge')
      const signature = await signNonce(privateKey, minted.nonce)
      const body = JSON.stringify({ challengeId: minted.challengeId, signature })

      const first = await app.request('/api/reconnect-session', {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body,
      })
      expect(first.status).toBe(200)

      const replay = await app.request('/api/reconnect-session', {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body,
      })
      expect(replay.status).toBe(403)
    })

    it('403s an expired challenge', async () => {
      const origin = 'http://localhost:5173'
      const trustStore = createWebOriginTrustStore({ dataDir })
      const { publicJwk, privateKey } = await generateKeyPair()
      await trustStore.enrollPublicKey(origin, publicJwk)
      let now = Date.parse('2026-01-01T00:00:00.000Z')
      const challengeStore = createReconnectChallengeStore({ now: () => now })
      const app = createReconnectRouter({
        trustStore,
        challengeStore,
        allowedWebOrigins: [origin],
        daemonToken: 'daemon-token-value',
      })

      const minted = challengeStore.mintChallenge(origin)
      if (minted === null) throw new Error('expected a minted challenge')
      const signature = await signNonce(privateKey, minted.nonce)

      now += 61_000 // past the 60s challenge TTL
      const res = await app.request('/api/reconnect-session', {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ challengeId: minted.challengeId, signature }),
      })
      expect(res.status).toBe(403)
    })

    it('403s a signature from the wrong key', async () => {
      const origin = 'http://localhost:5173'
      const { trustStore, challengeStore } = await enrollAndChallenge(origin)
      const { privateKey: wrongPrivateKey } = await generateKeyPair()
      const app = createReconnectRouter({
        trustStore,
        challengeStore,
        allowedWebOrigins: [origin],
        daemonToken: 'daemon-token-value',
      })

      const minted = challengeStore.mintChallenge(origin)
      if (minted === null) throw new Error('expected a minted challenge')
      const signature = await signNonce(wrongPrivateKey, minted.nonce)

      const res = await app.request('/api/reconnect-session', {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ challengeId: minted.challengeId, signature }),
      })
      expect(res.status).toBe(403)
    })

    it('400s a non-64-byte signature', async () => {
      const origin = 'http://localhost:5173'
      const { trustStore, challengeStore } = await enrollAndChallenge(origin)
      const app = createReconnectRouter({
        trustStore,
        challengeStore,
        allowedWebOrigins: [origin],
        daemonToken: 'daemon-token-value',
      })

      const minted = challengeStore.mintChallenge(origin)
      if (minted === null) throw new Error('expected a minted challenge')

      const res = await app.request('/api/reconnect-session', {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({
          challengeId: minted.challengeId,
          signature: Buffer.from('too-short').toString('base64url'),
        }),
      })
      expect(res.status).toBe(400)
    })

    it('403s a challenge redeemed from a different origin than it was minted for', async () => {
      const origin = 'http://localhost:5173'
      const { trustStore, challengeStore, privateKey } = await enrollAndChallenge(origin)
      const app = createReconnectRouter({
        trustStore,
        challengeStore,
        allowedWebOrigins: [origin, 'https://app.example.com'],
        daemonToken: 'daemon-token-value',
      })

      const minted = challengeStore.mintChallenge(origin)
      if (minted === null) throw new Error('expected a minted challenge')
      const signature = await signNonce(privateKey, minted.nonce)

      const res = await app.request('/api/reconnect-session', {
        method: 'POST',
        headers: { origin: 'https://app.example.com', 'content-type': 'application/json' },
        body: JSON.stringify({ challengeId: minted.challengeId, signature }),
      })
      expect(res.status).toBe(403)
    })

    it('403s an unknown/absent origin even with an otherwise-valid signature', async () => {
      const origin = 'http://localhost:5173'
      const { trustStore, challengeStore, privateKey } = await enrollAndChallenge(origin)
      const app = createReconnectRouter({
        trustStore,
        challengeStore,
        allowedWebOrigins: [origin],
        daemonToken: 'daemon-token-value',
      })

      const minted = challengeStore.mintChallenge(origin)
      if (minted === null) throw new Error('expected a minted challenge')
      const signature = await signNonce(privateKey, minted.nonce)

      const res = await app.request('/api/reconnect-session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ challengeId: minted.challengeId, signature }),
      })
      expect(res.status).toBe(403)
    })
  })

  describe('POST /api/reconnect-session — legacy secret grace path', () => {
    async function enrollLegacy(dataDirForStore: string, origin: string) {
      const trustStore = createWebOriginTrustStore({ dataDir: dataDirForStore })
      const { secret } = await trustStore.trustOrigin(origin)
      return { trustStore, secret }
    }

    it('returns the daemon token for a valid legacy secret + matching origin (no rotation)', async () => {
      const { trustStore, secret } = await enrollLegacy(dataDir, 'http://localhost:5173')
      const app = createReconnectRouter({
        trustStore,
        challengeStore: createReconnectChallengeStore(),
        allowedWebOrigins: ['http://localhost:5173'],
        daemonToken: 'daemon-token-value',
      })

      const res = await app.request('/api/reconnect-session', {
        method: 'POST',
        headers: { origin: 'http://localhost:5173', authorization: `Bearer ${secret}` },
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({ token: 'daemon-token-value' })

      // No rotation: the same secret verifies again.
      const again = await app.request('/api/reconnect-session', {
        method: 'POST',
        headers: { origin: 'http://localhost:5173', authorization: `Bearer ${secret}` },
      })
      expect(again.status).toBe(200)
    })

    it('403s when the Origin is correct but the secret is wrong or absent (forged-Origin insufficient)', async () => {
      const { trustStore } = await enrollLegacy(dataDir, 'http://localhost:5173')
      const app = createReconnectRouter({
        trustStore,
        challengeStore: createReconnectChallengeStore(),
        allowedWebOrigins: ['http://localhost:5173'],
        daemonToken: 'daemon-token-value',
      })

      const withGarbageSecret = await app.request('/api/reconnect-session', {
        method: 'POST',
        headers: { origin: 'http://localhost:5173', authorization: 'Bearer not-the-secret' },
      })
      expect(withGarbageSecret.status).toBe(403)

      const withNoCredential = await app.request('/api/reconnect-session', {
        method: 'POST',
        headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(withNoCredential.status).toBe(400)
    })

    it('403s an unknown/absent origin even with an otherwise-valid secret', async () => {
      const { trustStore, secret } = await enrollLegacy(dataDir, 'http://localhost:5173')
      const app = createReconnectRouter({
        trustStore,
        challengeStore: createReconnectChallengeStore(),
        allowedWebOrigins: ['http://localhost:5173'],
        daemonToken: 'daemon-token-value',
      })

      const unknownOrigin = await app.request('/api/reconnect-session', {
        method: 'POST',
        headers: { origin: 'http://evil.example.com', authorization: `Bearer ${secret}` },
      })
      expect(unknownOrigin.status).toBe(403)

      const absentOrigin = await app.request('/api/reconnect-session', {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}` },
      })
      expect(absentOrigin.status).toBe(403)
    })

    it('403s a trusted-but-delisted hosted origin (removed from the allowlist)', async () => {
      // Loopback origins are always admitted (same carve-out as the API CORS
      // middleware), so this exercises the delisting path with a hosted
      // (non-loopback) https origin instead.
      const { trustStore, secret } = await enrollLegacy(dataDir, 'https://app.example.com')
      const app = createReconnectRouter({
        trustStore,
        challengeStore: createReconnectChallengeStore(),
        allowedWebOrigins: [], // delisted from the current allowlist
        daemonToken: 'daemon-token-value',
      })

      const res = await app.request('/api/reconnect-session', {
        method: 'POST',
        headers: { origin: 'https://app.example.com', authorization: `Bearer ${secret}` },
      })
      expect(res.status).toBe(403)
    })

    it('origin canonicalization: hostname case and explicit default port are equivalent', async () => {
      const { trustStore, secret } = await enrollLegacy(dataDir, 'https://app.example.com')
      const app = createReconnectRouter({
        trustStore,
        challengeStore: createReconnectChallengeStore(),
        allowedWebOrigins: ['https://app.example.com'],
        daemonToken: 'daemon-token-value',
      })

      const res = await app.request('/api/reconnect-session', {
        method: 'POST',
        headers: { origin: 'https://APP.example.com:443', authorization: `Bearer ${secret}` },
      })
      expect(res.status).toBe(200)
    })

    it('403s an expired sliding-TTL trust record', async () => {
      let now = Date.parse('2026-01-01T00:00:00.000Z')
      const trustStore = createWebOriginTrustStore({ dataDir, now: () => now })
      const { secret } = await trustStore.trustOrigin('http://localhost:5173')
      const app = createReconnectRouter({
        trustStore,
        challengeStore: createReconnectChallengeStore(),
        allowedWebOrigins: ['http://localhost:5173'],
        daemonToken: 'daemon-token-value',
      })

      now += 31 * 24 * 60 * 60 * 1000
      const res = await app.request('/api/reconnect-session', {
        method: 'POST',
        headers: { origin: 'http://localhost:5173', authorization: `Bearer ${secret}` },
      })
      expect(res.status).toBe(403)
    })
  })
})
