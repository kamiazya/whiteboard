import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { withTempDataDir } from './routes/_test-helpers.js'

const tmp = withTempDataDir('whiteboard-app-oauth-authorize-cors-test-')

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

vi.mock('../daemon/ensure-daemon.js', () => ({
  ensureDaemon: vi.fn(async () => ({
    pid: 1,
    port: 3099,
    token: 'secret',
    version: '0.1.0',
    startedAt: '2026-04-24T00:00:00.000Z',
    baseUrl: 'http://daemon.test',
  })),
}))

const { createApp } = await import('./app.js')
const { PACKAGE_VERSION } = await import('../shared/package-version.js')

const HOSTED_ORIGIN = 'https://whiteboard.pages.dev'
const registry = [
  { clientId: 'whiteboard-hosted-web', redirectUris: [`${HOSTED_ORIGIN}/oauth/callback`] },
]

function buildApp() {
  return createApp({
    authMode: 'local-daemon' as const,
    allowedWebOrigins: [HOSTED_ORIGIN],
    oauthClientRegistry: registry,
    touch: vi.fn(),
    shutdown: vi.fn(async () => undefined),
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
      auth: { mode: 'local-token' as const, hasToken: false },
      storage: { dataDir: '/tmp', dataDirWritable: true },
      app: { served: true, buildPresent: false, ui: 'web-app' as const },
      mcp: { httpEnabled: true, endpoint: 'http://127.0.0.1:3099/mcp' },
      clients: { connected: 0, ready: 0 },
    }),
  })
}

// The approval surface is a top-level *navigation* target, never an XHR one.
// Reflecting an allowed web origin back on /authorize would let a page on that
// origin read the approval screen — and script the approval POST — cross-site,
// which is precisely the attack the double-submit CSRF binding and the
// SameSite=Strict cookie exist to prevent. The loopback CORS middleware
// therefore must cover only the metadata documents and /token.
describe('oauth /authorize CORS scope', () => {
  it('never reflects an allowed web origin on the approval endpoints', async () => {
    await mkdir(join(tmp.dir, 'web-app'), { recursive: true })
    await mkdir(join(tmp.dir, 'data'), { recursive: true })
    await writeFile(join(tmp.dir, 'web-app', 'index.html'), '<!DOCTYPE html><html></html>')
    const app = buildApp()

    for (const path of ['/authorize', '/authorize/decision']) {
      const preflight = await app.request(`http://127.0.0.1:3099${path}`, {
        method: 'OPTIONS',
        headers: {
          Host: '127.0.0.1:3099',
          Origin: HOSTED_ORIGIN,
          'Access-Control-Request-Method': 'POST',
        },
      })
      expect(
        preflight.headers.get('Access-Control-Allow-Origin'),
        `${path} preflight reflected an origin`,
      ).toBeNull()

      const get = await app.request(`http://127.0.0.1:3099${path}`, {
        headers: { Host: '127.0.0.1:3099', Origin: HOSTED_ORIGIN },
      })
      expect(
        get.headers.get('Access-Control-Allow-Origin'),
        `${path} response reflected an origin`,
      ).toBeNull()
    }
  })

  it('still reflects the allowed web origin on /token', async () => {
    const app = buildApp()
    const preflight = await app.request('http://127.0.0.1:3099/token', {
      method: 'OPTIONS',
      headers: {
        Host: '127.0.0.1:3099',
        Origin: HOSTED_ORIGIN,
        'Access-Control-Request-Method': 'POST',
      },
    })
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe(HOSTED_ORIGIN)
  })

  // The app-wide baseline security headers run AFTER the route and must not
  // *downgrade* a policy the route deliberately made stricter. The approval
  // page loads nothing and runs no script, so it ships `default-src 'none'`;
  // an isolated router test cannot see this, because the clobbering
  // middleware only exists in the composed app.
  it('does not downgrade the approval page CSP to the app-wide baseline', async () => {
    const app = buildApp()
    const res = await app.request('http://127.0.0.1:3099/authorize', {
      headers: { Host: '127.0.0.1:3099' },
    })
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
  })

  // The host guard is orthogonal to CORS and must NOT be dropped along with it:
  // a spoofed non-loopback Host is a DNS-rebinding vector on the approval
  // surface exactly as it is on /api/*.
  it('keeps the host guard on the approval endpoints', async () => {
    const app = buildApp()
    const res = await app.request('http://127.0.0.1:3099/authorize', {
      headers: { Host: 'evil.example.com' },
    })
    expect(res.status).toBe(403)
  })
})
