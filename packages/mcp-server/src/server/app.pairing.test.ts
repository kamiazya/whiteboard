/**
 * End-to-end pairing-grant flow through createApp: the daemon-served /pair
 * page persists a grant (Bearer-gated), the hosted origin exchanges the
 * single-use PKCE code for an origin-scoped session token on the PUBLIC
 * token route, and that token + Origin pair then authenticates ordinary
 * /api requests — while the granted origin is admitted by CORS without any
 * restart (allowlist provider).
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { withTempDataDir } from './routes/_test-helpers.js'

const tmp = withTempDataDir('whiteboard-app-pairing-test-')

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
const { createPairingGrantStore } = await import('./security/pairing-grant-store.js')
const { computeS256Challenge, createPairingCodeStore, createPairingTokenStore } = await import(
  './security/pairing-session.js'
)
const { PACKAGE_VERSION } = await import('../shared/package-version.js')

const HOSTED = 'https://latest.kamiazya-whiteboard.pages.dev'

function makeApp() {
  const grants = createPairingGrantStore(join(tmp.dir, 'data'))
  const pairing = {
    grants,
    codes: createPairingCodeStore(),
    tokens: createPairingTokenStore(),
  }
  const envOrigins: readonly string[] = []
  const app = createApp({
    authMode: 'local-daemon' as const,
    token: 'daemon-secret',
    touch: vi.fn(),
    shutdown: vi.fn(async () => undefined),
    allowedWebOrigins: () => [...envOrigins, ...grants.origins()],
    pairing,
    getStatus: () => ({
      ok: true,
      pid: 10,
      host: '127.0.0.1',
      port: 3099,
      baseUrl: 'http://127.0.0.1:3099',
      version: PACKAGE_VERSION,
      startedAt: '2026-04-23T00:00:00.000Z',
      uptimeMs: 100,
      idleForMs: 10,
      auth: { mode: 'local-token' as const, hasToken: true },
      storage: { dataDir: '/tmp', dataDirWritable: true },
      app: { served: true, buildPresent: false, ui: 'web-app' as const },
      mcp: { httpEnabled: true, endpoint: 'http://127.0.0.1:3099/mcp' },
      clients: { connected: 0, ready: 0 },
    }),
  })
  return app
}

describe('pairing-grant flow through createApp', () => {
  beforeEach(async () => {
    await mkdir(join(tmp.dir, 'web-app'), { recursive: true })
    await mkdir(join(tmp.dir, 'data'), { recursive: true })
    await writeFile(
      join(tmp.dir, 'web-app', 'index.html'),
      '<!DOCTYPE html><html><head><title>Whiteboard</title></head><body><div id="root"></div></body></html>',
    )
  })

  it('grant -> token exchange -> pairing token authenticates /api with the granted Origin', async () => {
    const app = makeApp()
    const codeVerifier = 'hosted-app-pkce-verifier'
    const codeChallenge = await computeS256Challenge(codeVerifier)

    // The consent page (daemon origin, carries the daemon token) persists
    // the grant. Without the Bearer it must be rejected.
    const unauthed = await app.request('/api/pairing/grants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin: HOSTED, codeChallenge }),
    })
    expect(unauthed.status).toBe(401)

    const grantRes = await app.request('/api/pairing/grants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer daemon-secret' },
      body: JSON.stringify({ origin: HOSTED, codeChallenge }),
    })
    expect(grantRes.status).toBe(201)
    const { code } = (await grantRes.json()) as { code: string }

    // The token route is PUBLIC (no Bearer) — the hosted origin does not
    // hold one yet. The single-use PKCE code is the credential.
    const tokenRes = await app.request('/api/pairing/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: HOSTED },
      body: JSON.stringify({ grantType: 'code', code, codeVerifier }),
    })
    expect(tokenRes.status).toBe(200)
    const { token } = (await tokenRes.json()) as { token: string }

    // The pairing token + Origin authenticates ordinary /api reads, and the
    // granted origin gets CORS headers with no restart in between.
    const listRes = await app.request('/api/workspaces', {
      headers: { Authorization: `Bearer ${token}`, Origin: HOSTED },
    })
    expect(listRes.status).toBe(200)
    expect(listRes.headers.get('access-control-allow-origin')).toBe(HOSTED)

    // Origin-scoped: the same token presented with a different Origin fails.
    const crossRes = await app.request('/api/workspaces', {
      headers: { Authorization: `Bearer ${token}`, Origin: 'https://evil.example.com' },
    })
    expect(crossRes.status).toBe(401)
  })

  it('renewal on a later visit needs no redirect: Origin + persisted grant mints a fresh token', async () => {
    const app = makeApp()
    const challenge = await computeS256Challenge('v')
    await app.request('/api/pairing/grants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer daemon-secret' },
      body: JSON.stringify({ origin: HOSTED, codeChallenge: challenge }),
    })

    const renewal = await app.request('/api/pairing/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: HOSTED },
      body: JSON.stringify({ grantType: 'origin' }),
    })
    expect(renewal.status).toBe(200)
    const { token } = (await renewal.json()) as { token: string }
    const listRes = await app.request('/api/workspaces', {
      headers: { Authorization: `Bearer ${token}`, Origin: HOSTED },
    })
    expect(listRes.status).toBe(200)
  })

  it('an ungranted origin can neither renew nor piggyback on CORS', async () => {
    const app = makeApp()
    const renewal = await app.request('/api/pairing/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' },
      body: JSON.stringify({ grantType: 'origin' }),
    })
    expect(renewal.status).toBe(403)

    const listRes = await app.request('/api/workspaces', {
      headers: { Authorization: 'Bearer daemon-secret', Origin: 'https://evil.example.com' },
    })
    expect(listRes.headers.get('access-control-allow-origin')).toBeNull()
  })
})
