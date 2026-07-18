import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWebOriginTrustStore } from '../security/web-origin-trust-store.js'
import { createReconnectRouter } from './reconnect.js'

describe('reconnect routes', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'whiteboard-reconnect-route-'))
  })

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  describe('POST /api/reconnect-credential', () => {
    it('mints a reconnect secret for an allowlisted origin', async () => {
      const trustStore = createWebOriginTrustStore({ dataDir })
      const app = createReconnectRouter({
        trustStore,
        allowedWebOrigins: ['http://localhost:5173'],
        daemonToken: 'daemon-token-value',
      })

      const res = await app.request('/api/reconnect-credential', {
        method: 'POST',
        headers: { origin: 'http://localhost:5173' },
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({ reconnectSecret: expect.any(String), expiresInDays: 30 })
    })

    it('403s an origin that is not on the allowlist', async () => {
      const trustStore = createWebOriginTrustStore({ dataDir })
      const app = createReconnectRouter({
        trustStore,
        allowedWebOrigins: ['http://localhost:5173'],
        daemonToken: 'daemon-token-value',
      })

      const res = await app.request('/api/reconnect-credential', {
        method: 'POST',
        headers: { origin: 'http://evil.example.com' },
      })

      expect(res.status).toBe(403)
    })

    it('403s when no Origin header is present', async () => {
      const trustStore = createWebOriginTrustStore({ dataDir })
      const app = createReconnectRouter({
        trustStore,
        allowedWebOrigins: ['http://localhost:5173'],
        daemonToken: 'daemon-token-value',
      })

      const res = await app.request('/api/reconnect-credential', { method: 'POST' })
      expect(res.status).toBe(403)
    })
  })

  describe('POST /api/reconnect-session', () => {
    async function enroll(dataDirForStore: string, origin: string) {
      const trustStore = createWebOriginTrustStore({ dataDir: dataDirForStore })
      const { secret } = await trustStore.trustOrigin(origin)
      return { trustStore, secret }
    }

    it('returns the daemon token for a valid secret + matching origin', async () => {
      const { trustStore, secret } = await enroll(dataDir, 'http://localhost:5173')
      const app = createReconnectRouter({
        trustStore,
        allowedWebOrigins: ['http://localhost:5173'],
        daemonToken: 'daemon-token-value',
      })

      const res = await app.request('/api/reconnect-session', {
        method: 'POST',
        headers: { origin: 'http://localhost:5173', authorization: `Bearer ${secret}` },
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({
        token: 'daemon-token-value',
        reconnectSecret: expect.any(String),
        expiresInDays: 30,
      })
      // Rotation: the old secret is dead immediately.
      expect(body.reconnectSecret).not.toBe(secret)
      const replay = await app.request('/api/reconnect-session', {
        method: 'POST',
        headers: { origin: 'http://localhost:5173', authorization: `Bearer ${secret}` },
      })
      expect(replay.status).toBe(403)
    })

    it('403s when the Origin is correct but the secret is wrong or absent (forged-Origin insufficient)', async () => {
      const { trustStore } = await enroll(dataDir, 'http://localhost:5173')
      const app = createReconnectRouter({
        trustStore,
        allowedWebOrigins: ['http://localhost:5173'],
        daemonToken: 'daemon-token-value',
      })

      const withGarbageSecret = await app.request('/api/reconnect-session', {
        method: 'POST',
        headers: { origin: 'http://localhost:5173', authorization: 'Bearer not-the-secret' },
      })
      expect(withGarbageSecret.status).toBe(403)

      const withNoSecret = await app.request('/api/reconnect-session', {
        method: 'POST',
        headers: { origin: 'http://localhost:5173' },
      })
      expect(withNoSecret.status).toBe(403)
    })

    it('403s an unknown/absent origin even with an otherwise-valid secret', async () => {
      const { trustStore, secret } = await enroll(dataDir, 'http://localhost:5173')
      const app = createReconnectRouter({
        trustStore,
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
      const { trustStore, secret } = await enroll(dataDir, 'https://app.example.com')
      const app = createReconnectRouter({
        trustStore,
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
      const { trustStore, secret } = await enroll(dataDir, 'https://app.example.com')
      const app = createReconnectRouter({
        trustStore,
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
