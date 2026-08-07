import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { withTempDataDir } from './routes/_test-helpers.js'

// Verifies the app.ts wiring for the hosted-origin OAuth 2.1 authorization-
// server surface (ADR-0005): the host guard and CORS handling this router
// needs do not come for free just from being registered — this is the
// regression test for that wiring, distinct from oauth-authz.test.ts's
// unit-level coverage of the router's own logic.

const tmp = withTempDataDir('whiteboard-app-oauth-authz-test-')

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
const { clearCache } = await import('./store/doc-cache.js')
const { clearWorkspaceIdCache } = await import('./mcp/session-resolver.js')
const { PACKAGE_VERSION } = await import('../shared/package-version.js')

const registry = [
  {
    clientId: 'whiteboard-hosted-web',
    redirectUris: ['https://whiteboard.pages.dev/oauth/callback'],
  },
]

function buildRuntimeOptions(overrides: Record<string, unknown> = {}) {
  return {
    authMode: 'local-daemon' as const,
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
      auth: { mode: 'local-token', hasToken: false },
      storage: { dataDir: '/tmp', dataDirWritable: true },
      app: { served: true, buildPresent: false, ui: 'web-app' },
      mcp: { httpEnabled: true, endpoint: 'http://127.0.0.1:3099/mcp' },
      clients: { connected: 0, ready: 0 },
    }),
    ...overrides,
  }
}

describe('createApp oauth-authz wiring', () => {
  beforeEach(async () => {
    await mkdir(join(tmp.dir, 'web-app'), { recursive: true })
    await mkdir(join(tmp.dir, 'data'), { recursive: true })
    clearCache()
    clearWorkspaceIdCache()
    await writeFile(
      join(tmp.dir, 'web-app', 'index.html'),
      '<!DOCTYPE html><html><head><title>Whiteboard</title></head><body><div id="root"></div></body></html>',
    )
  })

  afterEach(() => {
    clearCache()
    clearWorkspaceIdCache()
  })

  it('does not mount /token or the metadata endpoints when no registry is configured (empty by default)', async () => {
    const app = createApp(buildRuntimeOptions())
    const tokenRes = await app.request('http://127.0.0.1:3099/token', { method: 'POST' })
    expect(tokenRes.status).toBe(404)
    const metadataRes = await app.request(
      'http://127.0.0.1:3099/.well-known/oauth-authorization-server',
    )
    expect(metadataRes.status).toBe(404)
  })

  it('rejects a spoofed non-loopback Host on /token with 403 — trap #1, the host guard applies here too', async () => {
    const app = createApp(buildRuntimeOptions({ oauthClientRegistry: registry }))
    const res = await app.request('http://127.0.0.1:3099/token', {
      method: 'POST',
      headers: { Host: 'evil.example' },
    })
    expect(res.status).toBe(403)
  })

  it('rejects a spoofed Host on the metadata endpoints too', async () => {
    const app = createApp(buildRuntimeOptions({ oauthClientRegistry: registry }))
    const res = await app.request('http://127.0.0.1:3099/.well-known/oauth-authorization-server', {
      headers: { Host: 'evil.example' },
    })
    expect(res.status).toBe(403)
  })

  it('gives /token its own CORS: an admitted hosted origin gets Access-Control-Allow-Origin reflected', async () => {
    const app = createApp(
      buildRuntimeOptions({
        oauthClientRegistry: registry,
        allowedWebOrigins: ['https://whiteboard.pages.dev'],
      }),
    )
    const res = await app.request('http://127.0.0.1:3099/token', {
      method: 'OPTIONS',
      headers: { Host: '127.0.0.1:3099', Origin: 'https://whiteboard.pages.dev' },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://whiteboard.pages.dev')
  })

  it('does not reflect CORS for a non-admitted cross-origin caller on /token', async () => {
    const app = createApp(
      buildRuntimeOptions({
        oauthClientRegistry: registry,
        allowedWebOrigins: ['https://whiteboard.pages.dev'],
      }),
    )
    const res = await app.request('http://127.0.0.1:3099/token', {
      method: 'OPTIONS',
      headers: { Host: '127.0.0.1:3099', Origin: 'https://attacker.example' },
    })
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  it('does not inject the OAuth registry or client_id into the daemon-served index.html — trap #8', async () => {
    const app = createApp(
      buildRuntimeOptions({
        oauthClientRegistry: registry,
        allowedWebOrigins: ['https://whiteboard.pages.dev'],
      }),
    )
    const res = await app.request('http://127.0.0.1:3099/pair', {
      headers: { Host: '127.0.0.1:3099' },
    })
    const html = await res.text()
    // The daemon-served app must stay entirely out of the OAuth state,
    // storage, callback, and client_id path — it authenticates same-origin
    // requests with the raw injected daemon token only (see
    // __WHITEBOARD_DAEMON_TOKEN__ below in this same file), never a
    // registered OAuth client_id.
    expect(html).not.toContain('whiteboard-hosted-web')
    expect(html).not.toContain('code_verifier')
    expect(html).toContain('__WHITEBOARD_RUNTIME_CONFIG__')
  })
})
