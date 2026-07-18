import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { RuntimeStatusResponse } from '../shared/api-contracts/runtime.js'
import type { AppOptions, ServerModeAppOptions } from './app.js'
import type { AuthScope } from './security/auth-strategy.js'
import type { AsyncAuthStrategy } from './security/oauth-resource-strategy.js'

let tempDir: string

vi.mock('./config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
  // Server-mode never reads DIST_WEB_APP_DIR — its root serves a static
  // inline placeholder (see app.ts), not the apps/web build.
  DIST_WEB_APP_DIR: '/tmp/whiteboard/dist/web-app',
}))

const { createApp } = await import('./app.js')
const { planServerModeAuth } = await import('./security/server-mode-auth-plan.js')

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-server-mode-app-test-'))
})

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

// --- Helpers ---

function makeScopeStrategy(grantedScopes: readonly AuthScope[]): AsyncAuthStrategy {
  const granted = new Set<string>(grantedScopes)
  return {
    async authorize(input) {
      if (!input.authorizationHeader) {
        return { ok: false, status: 401, code: 'auth.required', wwwAuthenticate: 'Bearer' }
      }
      for (const scope of input.requiredScopes) {
        if (!granted.has(scope)) {
          return { ok: false, status: 403, code: 'auth.forbidden' }
        }
      }
      return {
        ok: true,
        context: { kind: 'oauth-resource-server', subject: 'test-sub', scopes: [...grantedScopes] },
      }
    },
  }
}

const BEARER = 'Bearer any-valid-server-mode-token'
const PUBLIC_URL = 'https://example.com'
const ALLOWED_ORIGINS: readonly string[] = ['https://example.com']

function makeInternalStatus(): RuntimeStatusResponse {
  return {
    ok: true,
    pid: 99999,
    host: '0.0.0.0',
    port: 3099,
    baseUrl: 'http://0.0.0.0:3099',
    version: '0.0.0',
    startedAt: '2024-01-01T00:00:00.000Z',
    uptimeMs: 0,
    idleForMs: 0,
    auth: { mode: 'local-token', hasToken: true },
    storage: { dataDir: '/Users/internal/data-dir', dataDirWritable: true },
    app: { served: true, buildPresent: true, ui: 'server-placeholder' },
    mcp: { httpEnabled: true, endpoint: 'http://0.0.0.0:3099/mcp' },
    clients: { connected: 0, ready: 0 },
  }
}

function makeServerModeOptions(
  grantedScopes: readonly AuthScope[],
  overrides?: Partial<ServerModeAppOptions>,
): ServerModeAppOptions {
  return {
    authMode: 'server-mode',
    publicBaseUrl: PUBLIC_URL,
    allowedOrigins: ALLOWED_ORIGINS,
    authStrategy: makeScopeStrategy(grantedScopes),
    touch: () => {},
    getStatus: makeInternalStatus,
    shutdown: () => Promise.resolve(),
    ...overrides,
  }
}

// --- Tests ---

describe('app — server-mode composition', () => {
  // Req 1: local-daemon unchanged
  it('local-daemon: createApp works without AuthStrategy', () => {
    expect(() =>
      createApp({
        authMode: 'local-daemon',
        token: 'local-token',
        touch: () => {},
        getStatus: () => makeInternalStatus(),
        shutdown: () => Promise.resolve(),
      }),
    ).not.toThrow()
  })

  it('local-daemon: GET /api/workspaces requires the same bearer as a mutation route', async () => {
    // ADR-0002's original GET carve-out is retired (see auth.ts): a hosted
    // origin admitted by CORS would otherwise read every canvas with no
    // credential at all. The client already sends the bearer on every read.
    const app = createApp({
      authMode: 'local-daemon',
      token: 'local-token',
      touch: () => {},
      getStatus: () => makeInternalStatus(),
      shutdown: () => Promise.resolve(),
    })
    const unauthedRes = await app.request('/api/workspaces')
    expect(unauthedRes.status).toBe(401)

    const res = await app.request('/api/workspaces', {
      headers: { Authorization: 'Bearer local-token' },
    })
    expect(res.status).toBe(200)
  })

  // R5 of the MCP-UI retirement (ADR 0001): server-mode's root serves a
  // static placeholder, not apps/web — apps/web's provider model has no
  // OAuth/JWT auth flow, only a local-daemon bearer token, so injecting the
  // apps/web build here without a real token would 401 on every request.
  describe('server-mode root serves a static placeholder (R5 UI retirement)', () => {
    it('GET / returns 200 text/html with no token or runtime-config injection', async () => {
      const app = createApp(makeServerModeOptions([]))
      const res = await app.request('/')
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/html')
      const html = await res.text()
      expect(html).not.toContain('__WHITEBOARD_DAEMON_TOKEN__')
      expect(html).not.toContain('__WHITEBOARD_RUNTIME_CONFIG__')
      expect(html).toContain('/mcp')
    })

    it('reserved prefixes (/api, /mcp, /ws, /.well-known) do not fall through to the placeholder', async () => {
      const app = createApp(makeServerModeOptions([]))
      const apiRes = await app.request('/api/not-real')
      expect(apiRes.status).not.toBe(200)
      const wellKnownRes = await app.request('/.well-known/unknown')
      expect(wellKnownRes.status).toBe(404)
    })
  })

  // Req 2: server-mode config validation via planServerModeAuth
  describe('server-mode config validation', () => {
    it('rejects non-HTTPS externalUrl', () => {
      const plan = planServerModeAuth({
        mode: 'server-mode',
        bindHost: '0.0.0.0',
        externalUrl: 'http://example.com',
      })
      expect(plan.ok).toBe(false)
      if (!plan.ok) expect(plan.code).toBe('server_mode.external_url_must_be_https')
    })

    it('rejects missing externalUrl', () => {
      const plan = planServerModeAuth({ mode: 'server-mode', bindHost: '0.0.0.0' })
      expect(plan.ok).toBe(false)
      if (!plan.ok) expect(plan.code).toBe('server_mode.external_url_required')
    })

    it('rejects wildcard allowedOrigins', () => {
      const plan = planServerModeAuth({
        mode: 'server-mode',
        bindHost: '0.0.0.0',
        externalUrl: 'https://example.com',
        allowedOrigins: ['*'],
      })
      expect(plan.ok).toBe(false)
      if (!plan.ok) expect(plan.code).toBe('server_mode.wildcard_origin_forbidden')
    })

    it('rejects externalUrl with path/query/fragment', () => {
      const plan = planServerModeAuth({
        mode: 'server-mode',
        bindHost: '0.0.0.0',
        externalUrl: 'https://example.com/some/path',
      })
      expect(plan.ok).toBe(false)
      if (!plan.ok) expect(plan.code).toBe('server_mode.external_url_must_be_origin')
    })

    it('createApp throws when publicBaseUrl is not HTTPS', () => {
      expect(() =>
        createApp({
          authMode: 'server-mode',
          publicBaseUrl: 'http://example.com',
          allowedOrigins: ['https://example.com'],
          authStrategy: makeScopeStrategy(['canvas:read']),
          touch: () => {},
          getStatus: () => makeInternalStatus(),
          shutdown: () => Promise.resolve(),
        }),
      ).toThrow('invalid server-mode config')
    })

    it('createApp throws when allowedOrigins contains wildcard', () => {
      expect(() =>
        createApp({
          authMode: 'server-mode',
          publicBaseUrl: 'https://example.com',
          allowedOrigins: ['*'],
          authStrategy: makeScopeStrategy(['canvas:read']),
          touch: () => {},
          getStatus: () => makeInternalStatus(),
          shutdown: () => Promise.resolve(),
        }),
      ).toThrow('invalid server-mode config')
    })

    it('valid config produces a server-mode plan with normalized publicBaseUrl', () => {
      const plan = planServerModeAuth({
        mode: 'server-mode',
        bindHost: '0.0.0.0',
        externalUrl: 'https://example.com',
        allowedOrigins: ['https://example.com'],
      })
      expect(plan.ok).toBe(true)
      if (plan.ok && plan.kind === 'server-mode') {
        expect(plan.publicBaseUrl).toBe('https://example.com')
        expect(plan.allowedOrigins).toContain('https://example.com')
        expect(plan.pnaHeader).toBe('disabled')
      }
    })

    it('failure code does not echo raw externalUrl content', () => {
      const plan = planServerModeAuth({
        mode: 'server-mode',
        bindHost: '0.0.0.0',
        externalUrl: 'https://user:password@secret-internal.example.com/path?token=abc123',
      })
      expect(plan.ok).toBe(false)
      const asText = JSON.stringify(plan)
      expect(asText).not.toContain('password')
      expect(asText).not.toContain('secret-internal')
      expect(asText).not.toContain('token=abc123')
    })
  })

  // Req 3: runtime status sanitized
  describe('server-mode runtime status sanitization', () => {
    it('response does not contain internal host, port, dataDir, or mcp endpoint', async () => {
      const app = createApp(makeServerModeOptions(['runtime:read']))
      const res = await app.request('/api/runtime/status', {
        headers: { authorization: BEARER },
      })
      expect(res.status).toBe(200)
      const text = await res.text()
      expect(text).not.toContain('0.0.0.0')
      expect(text).not.toContain('3099')
      expect(text).not.toContain('/Users/internal/data-dir')
      expect(text).not.toContain('http://0.0.0.0')
    })

    it('storage.dataDir is replaced with [server-managed]', async () => {
      const app = createApp(makeServerModeOptions(['runtime:read']))
      const res = await app.request('/api/runtime/status', { headers: { authorization: BEARER } })
      const body = (await res.json()) as Record<string, unknown>
      const storage = body.storage as Record<string, unknown>
      expect(storage.dataDir).toBe('[server-managed]')
    })

    it('mcp.endpoint is derived from publicBaseUrl', async () => {
      const app = createApp(
        makeServerModeOptions(['runtime:read'], {
          publicBaseUrl: 'https://myserver.example.com',
        }),
      )
      const res = await app.request('/api/runtime/status', { headers: { authorization: BEARER } })
      const body = (await res.json()) as Record<string, unknown>
      const mcp = body.mcp as Record<string, unknown>
      expect(mcp.endpoint).toBe('https://myserver.example.com/mcp')
    })

    it('port is 443 for https:// publicBaseUrl without explicit port', async () => {
      const app = createApp(makeServerModeOptions(['runtime:read']))
      const res = await app.request('/api/runtime/status', { headers: { authorization: BEARER } })
      const body = (await res.json()) as Record<string, unknown>
      expect(body.port).toBe(443)
    })

    it('port is derived from explicit port in publicBaseUrl', async () => {
      const app = createApp(
        makeServerModeOptions(['runtime:read'], {
          publicBaseUrl: 'https://example.com:8443',
          allowedOrigins: ['https://example.com:8443'],
        }),
      )
      const res = await app.request('/api/runtime/status', { headers: { authorization: BEARER } })
      const body = (await res.json()) as Record<string, unknown>
      expect(body.port).toBe(8443)
    })
  })

  describe('server-mode runtime scope tiers', () => {
    it('POST /api/runtime/logs/prune → 403 with runtime:read only (requires runtime:admin)', async () => {
      const app = createApp(makeServerModeOptions(['runtime:read']))
      const res = await app.request('/api/runtime/logs/prune', {
        method: 'POST',
        headers: { authorization: BEARER },
      })
      expect(res.status).toBe(403)
    })

    it('POST /api/runtime/logs/prune → reaches the route with runtime:admin', async () => {
      const app = createApp(makeServerModeOptions(['runtime:admin']))
      const res = await app.request('/api/runtime/logs/prune', {
        method: 'POST',
        headers: { authorization: BEARER },
      })
      expect(res.status).not.toBe(403)
    })
  })

  // Req 4: MCP origin policy
  describe('server-mode MCP origin policy', () => {
    it('rejects request with disallowed Origin → 403', async () => {
      const app = createApp(makeServerModeOptions(['mcp:call']))
      const res = await app.request('/mcp', {
        method: 'POST',
        headers: {
          origin: 'https://evil.com',
          authorization: BEARER,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
      })
      expect(res.status).toBe(403)
    })

    it('request without Origin header reaches auth layer (API clients are permitted)', async () => {
      // isOriginAllowedByPolicy returns true when Origin is absent — non-browser
      // API clients do not send Origin. The auth layer handles authz instead.
      // Use empty scopes so auth rejects with 403, proving origin gate passed.
      const app = createApp(makeServerModeOptions([]))
      const res = await app.request('/mcp', {
        method: 'POST',
        headers: {
          authorization: BEARER,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
      })
      expect(res.status).toBe(403)
    })

    it('allowed Origin passes origin check; auth layer is reached next', async () => {
      // No mcp:call scope → origin passes, auth rejects with 403
      const app = createApp(makeServerModeOptions([]))
      const res = await app.request('/mcp', {
        method: 'POST',
        headers: {
          origin: 'https://example.com',
          authorization: BEARER,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
      })
      expect(res.status).toBe(403)
    })

    it('wildcard-matched Origin passes origin check; auth layer is reached next', async () => {
      // Regression: createServerModeOriginMiddleware must be pattern-aware —
      // a naive exact-Set lookup over new URL(o).origin never admits a real
      // subdomain for a wildcard allowedOrigins entry.
      const app = createApp(
        makeServerModeOptions([], { allowedOrigins: ['https://*.example.com'] }),
      )
      const res = await app.request('/mcp', {
        method: 'POST',
        headers: {
          origin: 'https://preview.example.com',
          authorization: BEARER,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
      })
      expect(res.status).toBe(403) // origin gate passed; auth layer rejected (no scopes)
    })

    it('non-matching Origin still 403s under a wildcard allowedOrigins entry', async () => {
      const app = createApp(
        makeServerModeOptions(['mcp:call'], { allowedOrigins: ['https://*.example.com'] }),
      )
      const res = await app.request('/mcp', {
        method: 'POST',
        headers: {
          origin: 'https://evil.com',
          authorization: BEARER,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
      })
      expect(res.status).toBe(403)
    })
  })

  // Req 5: canvas scope through composed app
  describe('server-mode canvas scope via composed app', () => {
    it('GET /api/workspaces → 401 without auth header', async () => {
      const app = createApp(makeServerModeOptions(['workspace:read']))
      const res = await app.request('/api/workspaces')
      expect(res.status).toBe(401)
      expect(res.headers.get('WWW-Authenticate')).toBe('Bearer')
    })

    it('GET /api/workspaces → 403 with wrong scope', async () => {
      const app = createApp(makeServerModeOptions(['canvas:read']))
      const res = await app.request('/api/workspaces', { headers: { authorization: BEARER } })
      expect(res.status).toBe(403)
    })

    it('GET /api/workspaces → auth passes with workspace:read', async () => {
      const app = createApp(makeServerModeOptions(['workspace:read']))
      const res = await app.request('/api/workspaces', { headers: { authorization: BEARER } })
      expect(res.status).not.toBe(401)
      expect(res.status).not.toBe(403)
    })

    it('GET /api/canvas/:wid/:slug/snapshot → 403 with canvas:write only (requires canvas:read)', async () => {
      const app = createApp(makeServerModeOptions(['canvas:write']))
      const res = await app.request('/api/canvas/w1/canvas-a/snapshot', {
        headers: { authorization: BEARER },
      })
      expect(res.status).toBe(403)
    })

    it('POST /api/canvas/:wid/:slug/update → 403 with canvas:read only (requires canvas:write)', async () => {
      const app = createApp(makeServerModeOptions(['canvas:read']))
      const res = await app.request('/api/canvas/w1/canvas-a/update', {
        method: 'POST',
        headers: { authorization: BEARER },
      })
      expect(res.status).toBe(403)
    })
  })

  // POST /api/ws-ticket (ADR-0005) is local-daemon-only wiring in app.ts —
  // route-scope-registry.ts still declares a scope for it so /api/*
  // registry-wide coverage stays complete, but that declaration alone would
  // let a regression that mounts the route for server-mode too go unnoticed
  // (the auth middleware would just accept a well-scoped bearer and 401 an
  // unscoped one, either way never proving the route itself is unreachable).
  // Granting the declared scope here isolates that: if the route were ever
  // mistakenly mounted, this request would reach its handler instead of
  // falling through to the 404 catch-all.
  describe('server-mode ws-ticket route stays unmounted', () => {
    it('POST /api/ws-ticket → 404, not reachable even with the scope it declares', async () => {
      const app = createApp(makeServerModeOptions(['canvas:read']))
      const res = await app.request('/api/ws-ticket', {
        method: 'POST',
        headers: { authorization: BEARER },
      })
      expect(res.status).toBe(404)
    })
  })

  // The silent-reconnect surface (reconnect.ts) hands back the shared
  // daemon token, which server-mode has no equivalent of — it authenticates
  // through its own external-IdP AsyncAuthStrategy. reconnect-session is
  // declared `public` in route-scope-registry.ts for the local-daemon walk;
  // this pins that a server-mode app never mounts either route at all, so a
  // registry-only regression could not accidentally make it reachable here.
  describe('server-mode reconnect routes stay unmounted', () => {
    it('POST /api/reconnect-credential → 404', async () => {
      // Grant exactly the scope reconnect-credential declares in
      // route-scope-registry.ts, same as the ws-ticket case above: this
      // proves the 404 comes from the route never being mounted, not from
      // the shared auth middleware rejecting an under-scoped bearer first.
      const app = createApp(makeServerModeOptions(['runtime:admin']))
      const res = await app.request('/api/reconnect-credential', {
        method: 'POST',
        headers: { authorization: BEARER, origin: 'https://example.com' },
      })
      expect(res.status).toBe(404)
    })

    it('POST /api/reconnect-session → 404, not reachable despite being declared public', async () => {
      const app = createApp(makeServerModeOptions(['canvas:read']))
      const res = await app.request('/api/reconnect-session', {
        method: 'POST',
        headers: { origin: 'https://example.com' },
      })
      expect(res.status).toBe(404)
    })
  })

  // Req 6: files scope through composed app
  describe('server-mode files scope via composed app', () => {
    it('GET /api/canvas/:wid/:slug/file/:fileId → 401 without auth', async () => {
      const app = createApp(makeServerModeOptions(['files:read']))
      const res = await app.request('/api/canvas/w1/canvas-a/file/file-001')
      expect(res.status).toBe(401)
    })

    it('GET /api/canvas/:wid/:slug/file/:fileId → 403 with files:write only', async () => {
      const app = createApp(makeServerModeOptions(['files:write']))
      const res = await app.request('/api/canvas/w1/canvas-a/file/file-001', {
        headers: { authorization: BEARER },
      })
      expect(res.status).toBe(403)
    })

    it('PUT /api/canvas/:wid/:slug/file/:fileId → 403 with files:read only', async () => {
      const app = createApp(makeServerModeOptions(['files:read']))
      const res = await app.request('/api/canvas/w1/canvas-a/file/file-001', {
        method: 'PUT',
        headers: { authorization: BEARER, 'Content-Type': 'image/png' },
        body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      })
      expect(res.status).toBe(403)
    })
  })

  // Req 7: missing Authorization → 401 + WWW-Authenticate: Bearer
  it('missing Authorization → 401 + WWW-Authenticate: Bearer through composed app', async () => {
    const app = createApp(makeServerModeOptions(['workspace:read']))
    const res = await app.request('/api/workspaces')
    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toBe('Bearer')
  })

  // Req 8: insufficient scope → 403 + no WWW-Authenticate
  it('insufficient scope → 403 + no WWW-Authenticate through composed app', async () => {
    const app = createApp(makeServerModeOptions(['workspace:read']))
    const res = await app.request('/api/canvas/w1/c1/snapshot', {
      headers: { authorization: BEARER },
    })
    expect(res.status).toBe(403)
    expect(res.headers.get('WWW-Authenticate')).toBeNull()
  })

  // Previously-unguarded routes: import-migration-bundle, export, viewport, status, libraries, palette
  describe('server-mode: previously-unguarded routes are auth-gated', () => {
    it('POST /api/import-migration-bundle → 401 without auth', async () => {
      const app = createApp(makeServerModeOptions(['canvas:write']))
      const res = await app.request('/api/import-migration-bundle', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(401)
      expect(res.headers.get('WWW-Authenticate')).toBe('Bearer')
    })

    it('POST /api/import-migration-bundle → 403 with canvas:read only (requires canvas:write)', async () => {
      const app = createApp(makeServerModeOptions(['canvas:read']))
      const res = await app.request('/api/import-migration-bundle', {
        method: 'POST',
        headers: { authorization: BEARER, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(403)
    })

    it('POST /api/canvas/:wid/:slug/export → 401 without auth', async () => {
      const app = createApp(makeServerModeOptions(['canvas:write']))
      const res = await app.request('/api/canvas/w1/canvas-a/export', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(401)
    })

    it('POST /api/canvas/:wid/:slug/export → 403 with canvas:read only (requires canvas:write)', async () => {
      const app = createApp(makeServerModeOptions(['canvas:read']))
      const res = await app.request('/api/canvas/w1/canvas-a/export', {
        method: 'POST',
        headers: { authorization: BEARER, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(403)
    })

    it('POST /api/canvas/:wid/:slug/export-json → 401 without auth', async () => {
      const app = createApp(makeServerModeOptions(['canvas:write']))
      const res = await app.request('/api/canvas/w1/canvas-a/export-json', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(401)
      expect(res.headers.get('WWW-Authenticate')).toBe('Bearer')
    })

    it('POST /api/canvas/:wid/:slug/export-json → 403 with canvas:read only (requires canvas:write)', async () => {
      // Regression: export-json writes to the exports directory and supports overwrite;
      // canvas:read alone must not be sufficient to authorize this endpoint.
      const app = createApp(makeServerModeOptions(['canvas:read']))
      const res = await app.request('/api/canvas/w1/canvas-a/export-json', {
        method: 'POST',
        headers: { authorization: BEARER, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(403)
    })

    it('POST /api/canvas/:wid/:slug/export-json passes auth layer with canvas:write', async () => {
      const app = createApp(makeServerModeOptions(['canvas:write']))
      const res = await app.request('/api/canvas/w1/canvas-a/export-json', {
        method: 'POST',
        headers: { authorization: BEARER, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      // Auth layer passes; canvas handler may return 4xx for missing data.
      expect(res.status).not.toBe(401)
      expect(res.status).not.toBe(403)
    })

    it('POST /api/canvas/:wid/:slug/viewport → 401 without auth', async () => {
      const app = createApp(makeServerModeOptions(['canvas:read']))
      const res = await app.request('/api/canvas/w1/canvas-a/viewport', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(401)
    })

    it('POST /api/canvas/:wid/:slug/viewport → 403 with canvas:read only (requires canvas:write)', async () => {
      // Regression (security MEDIUM-1): viewport is a mutating POST that fell through the
      // /api/canvas/ catch-all and was authorized with canvas:read. It must require canvas:write.
      const app = createApp(makeServerModeOptions(['canvas:read']))
      const res = await app.request('/api/canvas/w1/canvas-a/viewport', {
        method: 'POST',
        headers: { authorization: BEARER, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(403)
    })

    it('POST /api/canvas/:wid/:slug/viewport passes auth layer with canvas:write', async () => {
      const app = createApp(makeServerModeOptions(['canvas:write']))
      const res = await app.request('/api/canvas/w1/canvas-a/viewport', {
        method: 'POST',
        headers: { authorization: BEARER, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).not.toBe(401)
      expect(res.status).not.toBe(403)
    })

    it('GET /api/canvas/:wid/:slug/client-count → 401 without auth', async () => {
      const app = createApp(makeServerModeOptions(['canvas:read']))
      const res = await app.request('/api/canvas/w1/canvas-a/client-count')
      expect(res.status).toBe(401)
    })

    it('GET /api/workspaces/:wid/libraries → 401 without auth', async () => {
      const app = createApp(makeServerModeOptions(['workspace:read']))
      const res = await app.request('/api/workspaces/w1/libraries')
      expect(res.status).toBe(401)
    })

    it('GET /api/workspaces/:wid/libraries → 403 with canvas:read only (requires workspace:read)', async () => {
      const app = createApp(makeServerModeOptions(['canvas:read']))
      const res = await app.request('/api/workspaces/w1/libraries', {
        headers: { authorization: BEARER },
      })
      expect(res.status).toBe(403)
    })

    it('GET /api/workspaces/:wid/libraries → auth passes with workspace:read', async () => {
      const app = createApp(makeServerModeOptions(['workspace:read']))
      const res = await app.request('/api/workspaces/w1/libraries', {
        headers: { authorization: BEARER },
      })
      expect(res.status).not.toBe(401)
      expect(res.status).not.toBe(403)
    })

    it('POST /api/workspaces/:wid/libraries → 403 with workspace:read only (requires workspace:write)', async () => {
      const app = createApp(makeServerModeOptions(['workspace:read']))
      const res = await app.request('/api/workspaces/w1/libraries', {
        method: 'POST',
        headers: { authorization: BEARER, 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/lib.json' }),
      })
      expect(res.status).toBe(403)
    })

    it('GET /api/workspaces/:wid/palette → 401 without auth', async () => {
      const app = createApp(makeServerModeOptions(['workspace:read']))
      const res = await app.request('/api/workspaces/w1/palette')
      expect(res.status).toBe(401)
    })

    it('GET /api/workspaces/:wid/palette → 403 with canvas:write only (requires workspace:read)', async () => {
      const app = createApp(makeServerModeOptions(['canvas:write']))
      const res = await app.request('/api/workspaces/w1/palette', {
        headers: { authorization: BEARER },
      })
      expect(res.status).toBe(403)
    })

    it('PUT /api/workspaces/:wid/palette → 403 with workspace:read only (requires workspace:write)', async () => {
      const app = createApp(makeServerModeOptions(['workspace:read']))
      const res = await app.request('/api/workspaces/w1/palette', {
        method: 'PUT',
        headers: { authorization: BEARER, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(403)
    })

    it('GET /api/user-libraries → 401 without auth', async () => {
      const app = createApp(makeServerModeOptions(['canvas:read']))
      const res = await app.request('/api/user-libraries')
      expect(res.status).toBe(401)
    })

    it('GET /api/user-libraries → 403 with runtime:read only (requires canvas:read)', async () => {
      const app = createApp(makeServerModeOptions(['runtime:read']))
      const res = await app.request('/api/user-libraries', { headers: { authorization: BEARER } })
      expect(res.status).toBe(403)
    })

    it('GET /api/user-libraries/foo/metadata → 401 without auth', async () => {
      const app = createApp(makeServerModeOptions(['canvas:read']))
      const res = await app.request('/api/user-libraries/foo/metadata')
      expect(res.status).toBe(401)
    })

    // Workspace write operations
    it('POST /api/workspaces/:wid/canvases → 403 with workspace:read only (requires workspace:write)', async () => {
      const app = createApp(makeServerModeOptions(['workspace:read']))
      const res = await app.request('/api/workspaces/w1/canvases', {
        method: 'POST',
        headers: { authorization: BEARER, 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'new-canvas', name: 'New Canvas' }),
      })
      expect(res.status).toBe(403)
    })

    it('PUT /api/workspaces/:wid/name → 403 with workspace:read only (requires workspace:write)', async () => {
      const app = createApp(makeServerModeOptions(['workspace:read']))
      const res = await app.request('/api/workspaces/w1/name', {
        method: 'PUT',
        headers: { authorization: BEARER, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'New Name' }),
      })
      expect(res.status).toBe(403)
    })

    it('PUT /api/workspaces/:wid/canvases/:slug/name → 403 with workspace:read only (requires workspace:write)', async () => {
      const app = createApp(makeServerModeOptions(['workspace:read']))
      const res = await app.request('/api/workspaces/w1/canvases/canvas-a/name', {
        method: 'PUT',
        headers: { authorization: BEARER, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'New Canvas Name' }),
      })
      expect(res.status).toBe(403)
    })

    // User library write operations
    it('PUT /api/user-libraries/:name → 403 with canvas:read only (requires workspace:write)', async () => {
      const app = createApp(makeServerModeOptions(['canvas:read']))
      const res = await app.request('/api/user-libraries/my-lib', {
        method: 'PUT',
        headers: { authorization: BEARER, 'content-type': 'application/json' },
        body: JSON.stringify({ elements: [] }),
      })
      expect(res.status).toBe(403)
    })

    it('DELETE /api/user-libraries/:name → 403 with canvas:read only (requires workspace:write)', async () => {
      const app = createApp(makeServerModeOptions(['canvas:read']))
      const res = await app.request('/api/user-libraries/my-lib', {
        method: 'DELETE',
        headers: { authorization: BEARER },
      })
      expect(res.status).toBe(403)
    })

    it('POST /api/user-libraries/:name/metadata → 403 with canvas:read only (requires workspace:write)', async () => {
      const app = createApp(makeServerModeOptions(['canvas:read']))
      const res = await app.request('/api/user-libraries/my-lib/metadata', {
        method: 'POST',
        headers: { authorization: BEARER, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(403)
    })

    // DELETE /api/workspaces/:wid/libraries requires workspace:write
    it('DELETE /api/workspaces/:wid/libraries → 403 with workspace:read only (requires workspace:write)', async () => {
      const app = createApp(makeServerModeOptions(['workspace:read']))
      const res = await app.request('/api/workspaces/w1/libraries', {
        method: 'DELETE',
        headers: { authorization: BEARER, 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/lib.json' }),
      })
      expect(res.status).toBe(403)
    })

    // Version history routes require versions:read/write
    it('GET /api/workspaces/:wid/canvases/:slug/versions → 403 with workspace:read only (requires versions:read)', async () => {
      const app = createApp(makeServerModeOptions(['workspace:read']))
      const res = await app.request('/api/workspaces/w1/canvases/canvas-a/versions', {
        headers: { authorization: BEARER },
      })
      expect(res.status).toBe(403)
    })

    it('GET /api/workspaces/:wid/canvases/:slug/versions → auth passes with versions:read', async () => {
      const app = createApp(makeServerModeOptions(['versions:read']))
      const res = await app.request('/api/workspaces/w1/canvases/canvas-a/versions', {
        headers: { authorization: BEARER },
      })
      expect(res.status).not.toBe(401)
      expect(res.status).not.toBe(403)
    })

    it('POST /api/workspaces/:wid/canvases/:slug/versions/:id/restore → 403 with versions:read only (requires versions:write)', async () => {
      const app = createApp(makeServerModeOptions(['versions:read']))
      const res = await app.request('/api/workspaces/w1/canvases/canvas-a/versions/v-001/restore', {
        method: 'POST',
        headers: { authorization: BEARER },
      })
      expect(res.status).toBe(403)
    })

    it('GET /api/workspaces/:wid/canvases/:slug/latest-thumbnail → 403 with workspace:read only (requires versions:read)', async () => {
      const app = createApp(makeServerModeOptions(['workspace:read']))
      const res = await app.request('/api/workspaces/w1/canvases/canvas-a/latest-thumbnail', {
        headers: { authorization: BEARER },
      })
      expect(res.status).toBe(403)
    })

    it('GET /api/workspaces/:wid/canvases/:slug/versions/:id/thumbnail → 403 with workspace:read only (requires versions:read)', async () => {
      const app = createApp(makeServerModeOptions(['workspace:read']))
      const res = await app.request(
        '/api/workspaces/w1/canvases/canvas-a/versions/v-001/thumbnail',
        {
          headers: { authorization: BEARER },
        },
      )
      expect(res.status).toBe(403)
    })

    it('PUT /api/workspaces/:wid/canvases/:slug/versions/:id/thumbnail → 403 with versions:read only (requires versions:write)', async () => {
      const app = createApp(makeServerModeOptions(['versions:read']))
      const res = await app.request(
        '/api/workspaces/w1/canvases/canvas-a/versions/v-001/thumbnail',
        {
          method: 'PUT',
          headers: { authorization: BEARER, 'content-type': 'image/png' },
          body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
        },
      )
      expect(res.status).toBe(403)
    })

    it('POST /api/workspaces/:wid/canvases/:slug/compact → 403 with workspace:write only (requires versions:write)', async () => {
      const app = createApp(makeServerModeOptions(['workspace:write']))
      const res = await app.request('/api/workspaces/w1/canvases/canvas-a/compact', {
        method: 'POST',
        headers: { authorization: BEARER },
      })
      expect(res.status).toBe(403)
    })

    // Branch write operations require versions:write
    it('POST /api/workspaces/:wid/canvases/:slug/branches → 403 with workspace:write only (requires versions:write)', async () => {
      const app = createApp(makeServerModeOptions(['workspace:write']))
      const res = await app.request('/api/workspaces/w1/canvases/canvas-a/branches', {
        method: 'POST',
        headers: { authorization: BEARER, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'feature' }),
      })
      expect(res.status).toBe(403)
    })

    it('GET /api/workspaces/:wid/canvases/:slug/branches → 403 with workspace:read only (requires versions:read)', async () => {
      const app = createApp(makeServerModeOptions(['workspace:read']))
      const res = await app.request('/api/workspaces/w1/canvases/canvas-a/branches', {
        headers: { authorization: BEARER },
      })
      expect(res.status).toBe(403)
    })

    it('GET /api/workspaces/:wid/canvases/:slug/branches → auth passes with versions:read', async () => {
      const app = createApp(makeServerModeOptions(['versions:read']))
      const res = await app.request('/api/workspaces/w1/canvases/canvas-a/branches', {
        headers: { authorization: BEARER },
      })
      expect(res.status).not.toBe(401)
      expect(res.status).not.toBe(403)
    })

    // /api/runtime/ping is public in server-mode (liveness probe)
    it('GET /api/runtime/ping → 200 without auth in server-mode', async () => {
      const app = createApp(makeServerModeOptions([]))
      const res = await app.request('/api/runtime/ping')
      expect(res.status).toBe(200)
    })
  })

  // Req 9: mode confusion
  it('mode confusion: local-daemon options cannot carry authStrategy', () => {
    expect(() =>
      createApp({
        authMode: 'local-daemon',
        authStrategy: makeScopeStrategy(['canvas:read']),
      } as unknown as AppOptions),
    ).toThrow('local-daemon mode must not receive authStrategy')
  })

  it('mode confusion: server-mode enforces per-scope auth, local-daemon only the shared bearer', async () => {
    // server-mode: GET /api/workspaces requires workspace:read — a bearer
    // with the wrong scope still 403s.
    const serverApp = createApp(makeServerModeOptions([]))
    const serverRes = await serverApp.request('/api/workspaces', {
      headers: { authorization: BEARER },
    })
    expect(serverRes.status).toBe(403)

    // local-daemon: same route requires only the single shared bearer, no
    // per-scope enforcement — presenting the daemon token is sufficient.
    const localApp = createApp({
      authMode: 'local-daemon',
      token: 'local-token',
      touch: () => {},
      getStatus: () => makeInternalStatus(),
      shutdown: () => Promise.resolve(),
    })
    const localRes = await localApp.request('/api/workspaces', {
      headers: { Authorization: 'Bearer local-token' },
    })
    expect(localRes.status).toBe(200)
  })

  // Req 10: non-leak
  it('401 failure body does not echo bearer token or internal paths', async () => {
    const SECRET = 'super-secret-server-mode-bearer-XYZABC12345'
    const alwaysDeny: AsyncAuthStrategy = {
      async authorize() {
        return { ok: false, status: 401, code: 'auth.required', wwwAuthenticate: 'Bearer' }
      },
    }
    const app = createApp({
      authMode: 'server-mode',
      publicBaseUrl: 'https://example.com',
      allowedOrigins: ['https://example.com'],
      authStrategy: alwaysDeny,
      touch: () => {},
      getStatus: () => makeInternalStatus(),
      shutdown: () => Promise.resolve(),
    })
    const res = await app.request('/api/workspaces', {
      headers: { authorization: `Bearer ${SECRET}` },
    })
    expect(res.status).toBe(401)
    const text = await res.text()
    expect(text).not.toContain(SECRET)
    expect(text).not.toMatch(/Bearer/i)
    expect(text).not.toMatch(/\/Users\//)
    expect(text).not.toMatch(/\/opt\//)
    expect(text).not.toMatch(/\.ts:\d/)
  })

  it('planServerModeAuth failure codes are opaque — raw input not echoed', () => {
    const plan = planServerModeAuth({
      mode: 'server-mode',
      bindHost: '0.0.0.0',
      externalUrl: 'https://user:password@secret-internal.example.com/path?token=abc123',
    })
    expect(plan.ok).toBe(false)
    const asText = JSON.stringify(plan)
    expect(asText).not.toContain('password')
    expect(asText).not.toContain('secret-internal')
    expect(asText).not.toContain('token=abc123')
  })

  it('server-mode does NOT add CORS or Access-Control-Allow-Private-Network headers on /api/*', async () => {
    const app = createApp(makeServerModeOptions(['canvas:read', 'canvas:write']))

    const getRes = await app.request('/api/runtime/ping', {
      headers: {
        Authorization: BEARER,
        Origin: 'http://localhost:5173',
      },
    })
    expect(getRes.headers.get('Access-Control-Allow-Origin')).toBeNull()
    expect(getRes.headers.get('Access-Control-Allow-Private-Network')).toBeNull()

    const optionsRes = await app.request('/api/runtime/ping', {
      method: 'OPTIONS',
      headers: {
        Authorization: BEARER,
        Origin: 'http://localhost:5173',
      },
    })
    expect(optionsRes.headers.get('Access-Control-Allow-Private-Network')).toBeNull()
  })
})
