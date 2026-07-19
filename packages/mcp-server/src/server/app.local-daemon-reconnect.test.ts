// Drives POST /api/reconnect-credential, POST /api/reconnect-challenge, and
// POST /api/reconnect-session through the real createApp({ authMode:
// 'local-daemon' }) composition — reconnect.test.ts only exercises
// createReconnectRouter directly with hand-built options, so it never proves
// the production wiring in app.ts: the default
// `options.webOriginTrustStore ?? createWebOriginTrustStore()` and
// `options.reconnectChallengeStore ?? createReconnectChallengeStore()`
// fallbacks, the `token ?? ''` tokenless fallback, and interaction with the
// rest of the local-daemon middleware stack (CORS, host guard, daemon-token
// auth) ahead of these routes.

import { webcrypto } from 'node:crypto'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EcP256PublicJwk } from '../shared/api-contracts/reconnect.js'
import { withTempDataDir } from './routes/_test-helpers.js'

const tmp = withTempDataDir('whiteboard-app-local-daemon-reconnect-')

vi.mock('./config.js', () => ({
  get DATA_DIR() {
    return join(tmp.dir, 'data')
  },
  getDataDir: () => join(tmp.dir, 'data'),
  get DIST_WEB_APP_DIR() {
    return join(tmp.dir, 'web-app')
  },
  WHITEBOARD_ROOT: '/tmp/whiteboard',
}))

const { createApp } = await import('./app.js')

const ORIGIN = 'http://localhost:5173'

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

function baseOptions(token?: string) {
  return {
    authMode: 'local-daemon' as const,
    token,
    touch: () => {},
    shutdown: async () => undefined,
    allowedWebOrigins: [ORIGIN],
    getStatus: () => ({
      ok: true,
      pid: 1,
      host: '127.0.0.1',
      port: 3099,
      baseUrl: 'http://127.0.0.1:3099',
      version: '0.0.0',
      startedAt: new Date().toISOString(),
      uptimeMs: 0,
      idleForMs: 0,
      auth: { mode: 'local-token', hasToken: Boolean(token) },
      storage: { dataDir: tmp.dir, dataDirWritable: true },
      app: { served: true, buildPresent: false, ui: 'web-app' },
      mcp: { httpEnabled: true, endpoint: 'http://127.0.0.1:3099/mcp' },
      clients: { connected: 0, ready: 0 },
    }),
  }
}

describe('createApp local-daemon reconnect wiring', () => {
  beforeEach(async () => {
    const { clearCache } = await import('./store/doc-cache.js')
    const { clearWorkspaceIdCache } = await import('./mcp/session-resolver.js')
    clearCache()
    clearWorkspaceIdCache()
  })

  it('enrolls a public key and reconnects through the real app composition, with the default trust + challenge stores', async () => {
    const token = 'daemon-token-value'
    const app = createApp(baseOptions(token))
    const { publicJwk, privateKey } = await generateKeyPair()

    const enroll = await app.request('/api/reconnect-credential', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        origin: ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ publicKeyJwk: publicJwk }),
    })
    expect(enroll.status).toBe(200)
    const enrollBody = await enroll.json()
    expect(enrollBody).toEqual({ credentialKind: 'publicKey', expiresInDays: 30 })

    const challenge = await app.request('/api/reconnect-challenge', {
      method: 'POST',
      headers: { origin: ORIGIN },
    })
    expect(challenge.status).toBe(200)
    const { challengeId, nonce } = await challenge.json()
    const signature = await signNonce(privateKey, nonce)

    const reconnect = await app.request('/api/reconnect-session', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId, signature }),
    })
    expect(reconnect.status).toBe(200)
    const body = await reconnect.json()
    expect(body.token).toBe(token)
  })

  it('refuses enrollment without the daemon token, even from an admitted origin', async () => {
    const app = createApp(baseOptions('daemon-token-value'))
    const { publicJwk } = await generateKeyPair()

    const res = await app.request('/api/reconnect-credential', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ publicKeyJwk: publicJwk }),
    })
    expect(res.status).toBe(401)
  })

  it('tokenless local-daemon mode: reconnect-session hands back the empty token instead of 500ing', async () => {
    // No `token` in options — the same "auth is a no-op" dev mode every
    // other /api/* route has. reconnect-credential requires no auth in this
    // mode either (isAuthorized returns true for an undefined token).
    const app = createApp(baseOptions(undefined))
    const { publicJwk, privateKey } = await generateKeyPair()

    const enroll = await app.request('/api/reconnect-credential', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ publicKeyJwk: publicJwk }),
    })
    expect(enroll.status).toBe(200)

    const challenge = await app.request('/api/reconnect-challenge', {
      method: 'POST',
      headers: { origin: ORIGIN },
    })
    expect(challenge.status).toBe(200)
    const { challengeId, nonce } = await challenge.json()
    const signature = await signNonce(privateKey, nonce)

    const reconnect = await app.request('/api/reconnect-session', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId, signature }),
    })
    expect(reconnect.status).toBe(200)
    const body = await reconnect.json()
    expect(body.token).toBe('')
  })

  it('legacy grace path: a Bearer secret enrolled via trustOrigin still reconnects through the real app composition', async () => {
    const token = 'daemon-token-value'
    // Injecting an explicit webOriginTrustStore (scoped to this test's own
    // scratch dir, same pattern app.ts documents for wsTicketStore) — not
    // the default store, which resolves against the REAL production data
    // dir (shared/data-dir-secure.js's DATA_DIR), unrelated to this file's
    // ./config.js mock — so this test can seed a pre-existing legacy record
    // without touching a real on-disk location.
    const { createWebOriginTrustStore } = await import('./security/web-origin-trust-store.js')
    const trustStore = createWebOriginTrustStore({ dataDir: join(tmp.dir, 'trust-data') })
    const app = createApp({ ...baseOptions(token), webOriginTrustStore: trustStore })

    // Simulate a pre-existing legacy-enrolled origin — there is no HTTP
    // enrollment path for the legacy secret anymore (enrollment is
    // publicKey-only), so this exercises verifyLegacySecret's grace period
    // for an origin that enrolled before the keypair migration.
    const { secret } = await trustStore.trustOrigin(ORIGIN)

    const reconnect = await app.request('/api/reconnect-session', {
      method: 'POST',
      headers: { origin: ORIGIN, authorization: `Bearer ${secret}` },
    })
    expect(reconnect.status).toBe(200)
    const body = await reconnect.json()
    expect(body.token).toBe(token)
  })
})
