// Registry-wide guard: every /api/* route actually mounted on the server-mode
// app must resolve to a declared scope decision here (`scoped` or the
// documented `public` carve-out) — never fall through silently. Mirrors
// `mcp/tool-registry-descriptions.test.ts`'s "walk what's actually
// registered, fail if the registry doesn't cover it" shape, applied to HTTP
// routes instead of MCP tool schemas.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AsyncAuthStrategy } from './oauth-resource-strategy.js'
import { resolveApiRouteScope } from './route-scope-registry.js'

let tempDir: string

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-route-scope-registry-test-'))
})

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

const alwaysDeny: AsyncAuthStrategy = {
  async authorize() {
    return { ok: false, status: 401, code: 'auth.required', wwwAuthenticate: 'Bearer' }
  },
}

describe('resolveApiRouteScope — registry-wide coverage of mounted /api/* routes', () => {
  it('every /api/* route mounted on the server-mode app resolves to a scope decision', async () => {
    const { createApp } = await import('../app.js')
    const app = createApp({
      authMode: 'server-mode',
      publicBaseUrl: 'https://example.com',
      allowedOrigins: ['https://example.com'],
      authStrategy: alwaysDeny,
      touch: () => {},
      getStatus: () => ({
        ok: true,
        pid: 1,
        host: '0.0.0.0',
        port: 3099,
        baseUrl: 'https://example.com',
        version: '0.0.0',
        startedAt: new Date().toISOString(),
        uptimeMs: 0,
        idleForMs: 0,
        auth: { mode: 'local-token', hasToken: true },
        storage: { dataDir: tempDir, dataDirWritable: true },
        app: { served: true, buildPresent: true, ui: 'server-placeholder' },
        mcp: { httpEnabled: true, endpoint: 'https://example.com/mcp' },
        clients: { connected: 0, ready: 0 },
      }),
      shutdown: () => Promise.resolve(),
    })

    // `app.routes` conflates middleware mounts (`app.use('/api/*', ...)`,
    // method 'ALL') with real endpoint handlers registered via `app.all(...)`
    // (also method 'ALL', e.g. debug.ts's `/api/debug`). Excluding all of
    // 'ALL' would silently skip those endpoints — the exact class of gap
    // this guard exists to catch. Distinguish by path shape instead:
    // middleware mounts use a wildcard suffix (`/api/*`), concrete endpoints
    // never do.
    const apiRoutes = app.routes.filter(
      (route) => route.path.startsWith('/api/') && !route.path.endsWith('*'),
    )
    expect(apiRoutes.length).toBeGreaterThan(0)

    const undeclared = apiRoutes
      .map((route) => ({ ...route, decision: resolveApiRouteScope(route.method, route.path) }))
      .filter((route) => route.decision === null)

    expect(
      undeclared,
      `routes mounted with no scope declaration: ${undeclared
        .map((r) => `${r.method} ${r.path}`)
        .join(', ')}`,
    ).toEqual([])
  })

  it('every /api/* route mounted on the local-daemon app resolves to a scope decision', async () => {
    // POST /api/ws-ticket only mounts under authMode: 'local-daemon' (see
    // app.ts), so the server-mode walk above never sees it — a local-daemon
    // app is built here too, or a newly local-daemon-only route could ship
    // with a registry gap the guard above would never catch.
    const { createApp } = await import('../app.js')
    const app = createApp({
      authMode: 'local-daemon',
      touch: () => {},
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
        auth: { mode: 'local-token', hasToken: false },
        storage: { dataDir: tempDir, dataDirWritable: true },
        app: { served: true, buildPresent: true, ui: 'server-placeholder' },
        mcp: { httpEnabled: true, endpoint: 'http://127.0.0.1:3099/mcp' },
        clients: { connected: 0, ready: 0 },
      }),
      shutdown: () => Promise.resolve(),
    })

    const apiRoutes = app.routes.filter(
      (route) => route.path.startsWith('/api/') && !route.path.endsWith('*'),
    )
    expect(apiRoutes.length).toBeGreaterThan(0)

    const undeclared = apiRoutes
      .map((route) => ({ ...route, decision: resolveApiRouteScope(route.method, route.path) }))
      .filter((route) => route.decision === null)

    expect(
      undeclared,
      `routes mounted with no scope declaration: ${undeclared
        .map((r) => `${r.method} ${r.path}`)
        .join(', ')}`,
    ).toEqual([])
  })

  it('POST /api/ws-ticket requires canvas:read (ADR-0005 connection ticket mint)', () => {
    expect(resolveApiRouteScope('POST', '/api/ws-ticket')).toEqual({
      kind: 'scoped',
      scopes: ['canvas:read'],
    })
  })

  it('POST /api/reconnect-credential requires daemon-token-only, never an OAuth grant scope', () => {
    expect(resolveApiRouteScope('POST', '/api/reconnect-credential')).toEqual({
      kind: 'daemon-token-only',
    })
  })

  it('POST /api/reconnect-challenge is public (mints regardless of enrollment, no enrollment oracle)', () => {
    expect(resolveApiRouteScope('POST', '/api/reconnect-challenge')).toEqual({ kind: 'public' })
  })

  it('POST /api/reconnect-session is public (see reconnect.ts for its own gates)', () => {
    expect(resolveApiRouteScope('POST', '/api/reconnect-session')).toEqual({ kind: 'public' })
  })

  it('an undeclared path resolves to null (fail-closed signal, not a default scope)', () => {
    expect(resolveApiRouteScope('GET', '/api/some-route-nobody-declared-yet')).toBeNull()
  })

  it('GET /api/runtime/ping is the sole declared public route', () => {
    expect(resolveApiRouteScope('GET', '/api/runtime/ping')).toEqual({ kind: 'public' })
  })

  it('a non-/api path is out of scope for this registry (null, not silently public)', () => {
    expect(resolveApiRouteScope('GET', '/mcp')).toBeNull()
    expect(resolveApiRouteScope('GET', '/')).toBeNull()
  })

  // The file-route rule must key off the write/read split, not off the one
  // write verb that happens to be mounted today — otherwise adding a DELETE
  // (or POST) file route later silently authorizes a mutation with a
  // read-only credential.
  it('any write verb on a file route requires files:write, not just PUT', () => {
    const filePath = '/api/canvas/ws1/main/file/abc'
    expect(resolveApiRouteScope('GET', filePath)).toEqual({
      kind: 'scoped',
      scopes: ['files:read'],
    })
    for (const method of ['PUT', 'POST', 'PATCH', 'DELETE']) {
      expect(resolveApiRouteScope(method, filePath), `${method} on a file route`).toEqual({
        kind: 'scoped',
        scopes: ['files:write'],
      })
    }
  })

  // Destructive maintenance routes must not fall through to the broad
  // /api/workspaces workspace:write fallback — they need the narrower scope
  // that actually matches what they mutate (attachments vs. canvas history).
  it('purge-dangling files requires files:write, not the workspace:write fallback', () => {
    expect(resolveApiRouteScope('POST', '/api/workspaces/w1/files/purge-dangling')).toEqual({
      kind: 'scoped',
      scopes: ['files:write'],
    })
  })

  it('optimize-all canvases requires versions:write, not the workspace:write fallback', () => {
    expect(resolveApiRouteScope('POST', '/api/workspaces/w1/canvases/optimize-all')).toEqual({
      kind: 'scoped',
      scopes: ['versions:write'],
    })
  })
})
