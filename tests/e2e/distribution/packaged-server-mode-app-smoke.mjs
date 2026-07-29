#!/usr/bin/env node
// Smoke: server-mode auth/exposure contract at dist-artifact level.
//
// Imports createApp and planServerModeAuth from the built dist artifacts
// (not TypeScript source) to verify the server-mode composition survives
// the build pipeline. Exercises the Hono app in-process via app.request()
// so no real TCP port is needed.
//
// Scenarios:
//   1. Invalid config → fail-closed throw (no credential echo)
//   2. Origin normalization: https://example.com:443 → https://example.com
//   3. Config canary non-leak (credentials in externalUrl not echoed)
//   4. Runtime status sanitization (no internal host/port/dataDir)
//   5. Data-route auth gates: workspaces, canvas export, workspace palette,
//      user-libraries — 401 without auth, 403 with wrong scope, pass with
//      correct scope; error responses pass LEAK_PATTERNS guard
//   6. Local-daemon auth: /api/* requires the daemon token (401 without,
//      pass with) — only /api/runtime/ping is public
//   7. WWW-Authenticate contract: 401 carries it, 403 does not

import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertNoLeak as assertNoLeakHelper } from './smoke-helpers.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const DIST_SERVER = resolve(REPO_ROOT, 'packages/mcp-server/dist/server')

if (!existsSync(join(DIST_SERVER, 'app.js'))) {
  console.error(
    '[server-mode-smoke] FAIL: dist/server/app.js missing.\n' +
      'Run `pnpm --filter @kamiazya/whiteboard-mcp build` before this smoke.',
  )
  process.exit(1)
}

// Deterministic test bearer token. Its literal value is in LEAK_PATTERNS
// so any error response that echoes it back is caught immediately.
const SMOKE_TOKEN = 'smoke-bearer-secret-xyzzy-789'
const PUBLIC_URL = 'https://smoke.example.com'
const ALLOWED_ORIGINS = ['https://smoke.example.com']
const RESOLVED_TMP = realpathSync(tmpdir())

function fail(msg, ctx = {}) {
  console.error(`[server-mode-smoke] FAIL: ${msg}`)
  for (const [k, v] of Object.entries(ctx)) {
    if (v !== undefined && v !== '') {
      console.error(`  ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    }
  }
  process.exit(1)
}

// assertNoLeakHelper (BASE_LEAK_PATTERNS) is imported from smoke-helpers.mjs.
// This wrapper adds the script-specific token, the 0.0.0.0 bind address,
// and the canonical-tmpdir check.
function assertNoLeak(label, text) {
  assertNoLeakHelper(label, text, [SMOKE_TOKEN, 'http://0.0.0.0'])
  if (RESOLVED_TMP && text.includes(RESOLVED_TMP)) {
    fail(`${label}: resolved tmpdir path leaked`)
  }
}

const tempDirs = []
function makeTempDir(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(d)
  return d
}
function cleanup() {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true })
}

// Set WHITEBOARD_DATA_DIR before any dynamic imports so dist/server/config.js
// captures the temp path at module evaluation time.
const dataDir = makeTempDir('whiteboard-server-mode-smoke-')
process.env.WHITEBOARD_DATA_DIR = dataDir

const [{ createApp }, { planServerModeAuth }] = await Promise.all([
  import(`${DIST_SERVER}/app.js`),
  import(`${DIST_SERVER}/security/server-mode-auth-plan.js`),
])

// Fake deterministic auth strategy — no real OAuth/JWKS involved.
// Returns 401 when Authorization header is absent, 403 when the required
// scope is not in the granted set, ok otherwise.
function makeScopeStrategy(grantedScopes) {
  const granted = new Set(grantedScopes)
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
        context: {
          kind: 'oauth-resource-server',
          subject: 'smoke-sub',
          scopes: [...grantedScopes],
        },
      }
    },
  }
}

// Internal status carries values that server-mode must sanitize before
// exposing via /api/runtime/status.
function makeInternalStatus() {
  return {
    ok: true,
    pid: 99999,
    host: '0.0.0.0',
    port: 9999,
    baseUrl: 'http://0.0.0.0:9999',
    version: '0.0.0-smoke',
    startedAt: '2024-01-01T00:00:00.000Z',
    uptimeMs: 0,
    idleForMs: 0,
    auth: { mode: 'local-token', hasToken: true },
    storage: { dataDir, dataDirWritable: true },
    app: { served: false, buildPresent: false },
    mcp: { httpEnabled: false, endpoint: 'http://0.0.0.0:9999/mcp' },
    clients: { connected: 0, ready: 0 },
  }
}

function makeApp(scopes, overrides = {}) {
  return createApp({
    authMode: 'server-mode',
    publicBaseUrl: PUBLIC_URL,
    allowedOrigins: ALLOWED_ORIGINS,
    authStrategy: makeScopeStrategy(scopes),
    touch: () => {},
    getStatus: makeInternalStatus,
    shutdown: () => Promise.resolve(),
    ...overrides,
  })
}

async function req(app, method, path, opts = {}) {
  const headers = {}
  if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`
  if (opts.origin) headers.Origin = opts.origin
  return app.request(path, { method, headers })
}

try {
  // --- Scenario 1: invalid config fail-closed ---
  {
    let threw = null
    try {
      createApp({
        authMode: 'server-mode',
        publicBaseUrl: 'http://example.com', // non-HTTPS
        allowedOrigins: ['https://example.com'],
        authStrategy: makeScopeStrategy([]),
        touch: () => {},
        getStatus: makeInternalStatus,
        shutdown: () => Promise.resolve(),
      })
    } catch (e) {
      threw = e
    }
    if (!threw) fail('1a: non-HTTPS publicBaseUrl must throw')
    if (!threw.message.includes('invalid server-mode config')) {
      fail('1a: throw message must contain "invalid server-mode config"', {
        message: threw.message,
      })
    }
    assertNoLeak('1a error message', threw.message)
  }
  {
    let threw = null
    try {
      createApp({
        authMode: 'server-mode',
        publicBaseUrl: 'https://example.com',
        allowedOrigins: ['*'], // wildcard
        authStrategy: makeScopeStrategy([]),
        touch: () => {},
        getStatus: makeInternalStatus,
        shutdown: () => Promise.resolve(),
      })
    } catch (e) {
      threw = e
    }
    if (!threw) fail('1b: wildcard allowedOrigins must throw')
    if (!threw.message.includes('invalid server-mode config')) {
      fail('1b: throw message must contain "invalid server-mode config"', {
        message: threw.message,
      })
    }
  }
  console.log('[server-mode-smoke] scenario 1 (invalid config fail-closed): PASS')

  // --- Scenario 2: origin normalization ---
  {
    const plan = planServerModeAuth({
      mode: 'server-mode',
      bindHost: '0.0.0.0',
      externalUrl: 'https://example.com:443',
      allowedOrigins: ['https://example.com:443'],
    })
    if (!plan.ok) fail('2: expected valid plan for :443 URL', { plan: JSON.stringify(plan) })
    if (plan.publicBaseUrl !== 'https://example.com') {
      fail('2: publicBaseUrl not normalized (expected https://example.com)', {
        got: plan.publicBaseUrl,
      })
    }
    if (!plan.allowedOrigins.includes('https://example.com')) {
      fail('2: allowedOrigins not normalized', { got: JSON.stringify(plan.allowedOrigins) })
    }
  }
  console.log('[server-mode-smoke] scenario 2 (origin normalization): PASS')

  // --- Scenario 2b: origin normalization wired through app composition ---
  // Guards against a regression where buildServerModeApp passes raw
  // options.allowedOrigins instead of plan.allowedOrigins to the MCP origin
  // middleware. The app receives the :443 form; the normalized origin
  // (https://norm-check.example.com) must pass the gate and reach the auth
  // layer (→ 401), not be rejected as a disallowed origin (→ 403).
  {
    const appNorm = createApp({
      authMode: 'server-mode',
      publicBaseUrl: 'https://norm-check.example.com',
      allowedOrigins: ['https://norm-check.example.com:443'],
      authStrategy: makeScopeStrategy([]),
      touch: () => {},
      getStatus: makeInternalStatus,
      shutdown: () => Promise.resolve(),
    })
    const res = await req(appNorm, 'POST', '/mcp', { origin: 'https://norm-check.example.com' })
    if (res.status === 403) {
      fail(
        '2b: normalized origin was rejected by MCP gate — suggests raw options.allowedOrigins ' +
          'was used instead of plan.allowedOrigins in buildServerModeApp',
        { status: res.status },
      )
    }
    if (res.status !== 401) {
      fail('2b: expected 401 (auth required) after origin gate passes', { status: res.status })
    }
  }
  console.log('[server-mode-smoke] scenario 2b (origin normalization in app composition): PASS')

  // --- Scenario 3: config canary non-leak ---
  {
    const plan = planServerModeAuth({
      mode: 'server-mode',
      bindHost: '0.0.0.0',
      externalUrl:
        'https://canary-user:canary-pass@canary-internal.example.com/path?tok=canary-xyz',
    })
    if (plan.ok) fail('3: expected plan to reject credential URL')
    const asText = JSON.stringify(plan)
    if (asText.includes('canary-pass')) fail('3: password leaked in plan result', { asText })
    if (asText.includes('canary-internal')) fail('3: hostname leaked in plan result', { asText })
    if (asText.includes('canary-xyz')) fail('3: token leaked in plan result', { asText })
  }
  console.log('[server-mode-smoke] scenario 3 (config canary non-leak): PASS')

  // --- Scenario 4: runtime status sanitization ---
  {
    const app = makeApp(['runtime:read'])
    const res = await req(app, 'GET', '/api/runtime/status', { bearer: SMOKE_TOKEN })
    if (res.status !== 200) fail('4: expected 200 on /api/runtime/status', { status: res.status })
    const body = await res.text()
    if (body.includes('0.0.0.0')) fail('4: internal bind host leaked in status response', { body })
    if (body.includes(dataDir)) fail('4: dataDir path leaked in status response', { body })
    // Internal port is sanitized to the public URL port (443 for https://smoke.example.com),
    // so we check the internal bind address form, not the bare port number.
    if (body.includes('http://0.0.0.0'))
      fail('4: internal bind URL leaked in status response', { body })
  }
  console.log('[server-mode-smoke] scenario 4 (runtime status sanitization): PASS')

  // --- Scenario 5a: GET /api/workspaces — workspace:read ---
  {
    const appEmpty = makeApp([])

    const res401 = await req(appEmpty, 'GET', '/api/workspaces')
    const status401 = res401.status
    const wwwa401 = res401.headers.get('WWW-Authenticate')
    const body401 = await res401.text()
    if (status401 !== 401) fail('5a: expected 401 without auth', { status: status401 })
    if (wwwa401 !== 'Bearer')
      fail('5a: 401 must have WWW-Authenticate: Bearer', { header: wwwa401 })
    assertNoLeak('5a 401', body401)

    const res403 = await req(appEmpty, 'GET', '/api/workspaces', { bearer: SMOKE_TOKEN })
    const status403 = res403.status
    const wwwa403 = res403.headers.get('WWW-Authenticate')
    const body403 = await res403.text()
    if (status403 !== 403) fail('5a: expected 403 with empty scopes', { status: status403 })
    if (wwwa403) fail('5a: 403 must not have WWW-Authenticate', { header: wwwa403 })
    assertNoLeak('5a 403', body403)

    const appRead = makeApp(['workspace:read'])
    const resPass = await req(appRead, 'GET', '/api/workspaces', { bearer: SMOKE_TOKEN })
    if (resPass.status === 401 || resPass.status === 403) {
      fail('5a: workspace:read must pass auth gate', { status: resPass.status })
    }
  }
  console.log('[server-mode-smoke] scenario 5a (workspaces auth): PASS')

  // --- Scenario 5b: POST /api/canvas/:wid/:slug/export — canvas:write ---
  {
    const appEmpty = makeApp([])
    const res401 = await req(appEmpty, 'POST', '/api/canvas/w1/s1/export')
    if (res401.status !== 401) fail('5b: expected 401 without auth', { status: res401.status })
    assertNoLeak('5b 401', await res401.text())

    const appRead = makeApp(['canvas:read'])
    const res403 = await req(appRead, 'POST', '/api/canvas/w1/s1/export', { bearer: SMOKE_TOKEN })
    if (res403.status !== 403) {
      fail('5b: canvas:read must be 403 on canvas:write export route', { status: res403.status })
    }
    assertNoLeak('5b 403', await res403.text())

    const appWrite = makeApp(['canvas:write'])
    const resPass = await req(appWrite, 'POST', '/api/canvas/w1/s1/export', { bearer: SMOKE_TOKEN })
    if (resPass.status === 401 || resPass.status === 403) {
      fail('5b: canvas:write must pass auth gate on export', { status: resPass.status })
    }
  }
  console.log('[server-mode-smoke] scenario 5b (canvas export auth): PASS')

  // --- Scenario 6: local-daemon auth — every /api/* route needs the daemon
  // token (only /api/runtime/ping is public; see requiresDaemonAuth in
  // routes/auth.ts). Local-daemon mode never had a truly unauthenticated
  // /api/* surface once this hardening shipped.
  {
    let threw = false
    let appLocal
    const LOCAL_TOKEN = 'local-daemon-token'
    try {
      appLocal = createApp({
        authMode: 'local-daemon',
        token: LOCAL_TOKEN,
        touch: () => {},
        getStatus: makeInternalStatus,
        shutdown: () => Promise.resolve(),
      })
    } catch {
      threw = true
    }
    if (threw) fail('6: local-daemon createApp must not throw')

    const resNoAuth = await appLocal.request('/api/workspaces')
    if (resNoAuth.status !== 401) {
      fail('6: local-daemon /api/workspaces without a token must be 401', {
        status: resNoAuth.status,
      })
    }
    assertNoLeak('6 401', await resNoAuth.text())

    const resAuthed = await appLocal.request('/api/workspaces', {
      headers: { Authorization: `Bearer ${LOCAL_TOKEN}` },
    })
    if (resAuthed.status === 401 || resAuthed.status === 403) {
      fail('6: local-daemon /api/workspaces with the daemon token must pass auth gate', {
        status: resAuthed.status,
      })
    }
  }
  console.log('[server-mode-smoke] scenario 6 (local-daemon daemon-token auth): PASS')

  // --- Scenario 7: server-mode root serves the static placeholder, not apps/web ---
  // R5 of the MCP-UI retirement (ADR 0001): server-mode has no apps/web-compatible
  // auth flow, so its root must never inject a token or runtime-config.
  {
    const app = makeApp([])
    const res = await app.request('/')
    if (res.status !== 200) fail('7: expected 200 on server-mode root', { status: res.status })
    const body = await res.text()
    if (body.includes('__WHITEBOARD_DAEMON_TOKEN__')) {
      fail('7: server-mode root must not inject a daemon token')
    }
    if (body.includes('__WHITEBOARD_RUNTIME_CONFIG__')) {
      fail('7: server-mode root must not inject apps/web runtime-config')
    }
    if (!body.includes('/mcp')) {
      fail('7: server-mode placeholder must point operators at /mcp')
    }
  }
  console.log('[server-mode-smoke] scenario 7 (root serves static placeholder): PASS')

  console.log('[server-mode-smoke] all scenarios passed')
} finally {
  cleanup()
}
