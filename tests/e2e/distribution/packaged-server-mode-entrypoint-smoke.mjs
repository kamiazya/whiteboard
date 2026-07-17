#!/usr/bin/env node
// Smoke: `whiteboard server run --json` CLI entrypoint at dist-artifact level.
//
// Scenarios 1-7 use spawnSync — no real TCP bind, no network requests.
// Scenario 8 spawns a real server with a local JWKS mock and verifies the
// full OAuth auth contract at the distribution boundary.
//
// Scenarios:
//   1.  Non-HTTPS externalUrl (plan-error)       → exit 1, stdout empty, stderr safe
//   2.  Valid dry-run                            → exit 0, stdout JSON, fields correct
//   3.  Origin normalization :443 → :stripped    → allowedOrigins normalized in output
//   4.  Wildcard origin (config-error)           → exit 1, stdout empty, stderr safe
//   5.  Unknown server subcommand               → exit 64, USAGE lists server run
//   6.  Missing --json                          → exit 64, stdout empty
//   7.  CLI flags override env (jwt-audience)   → correct audience in dry-run result
//   8.  Actual server run + JWKS mock           → ready JSON shape, /ping, auth contract
//   9.  server status while running             → ok:true, state:running, fields match
//  10.  server stop while running               → ok:true, action:stopped
//  11.  server status after stop                → ok:false, state:missing
//  12.  server status, no record                → ok:false, state:missing, exit 1
//  13.  server stop, no record                  → ok:true, action:not-running, exit 0
//  14.  server doctor, valid config + JWKS mock → exit 0, ok:true, server.jwks ok
//  15.  server doctor, invalid config           → exit 1, ok:false, error check present, stderr safe
//  16.  server doctor, stale record             → identity skipped, permissions warning (POSIX)
//   Regression: local daemon routing unchanged  → existing daemon chain not broken
//
// Port 4290 is used by scenario 8 (distinct from 4250/4260/4270/4280/4282).
// Scenarios 14–16 JWKS mock uses port 0 (OS-assigned, avoids collisions).

import { spawn, spawnSync } from 'node:child_process'
import { createSign, generateKeyPairSync } from 'node:crypto'
import { createServer as createHttpsServer } from 'node:https'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { assertNoLeak as assertNoLeakHelper, scrubDevEnv } from './smoke-helpers.mjs'

// Minimal ES256 JWT helpers using Node.js built-in crypto only.
// (Distribution smokes run with plain `node`, not in the pnpm workspace.)

function base64url(data) {
  const buf = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data)
  return buf.toString('base64url')
}

/**
 * Convert an ASN.1 DER-encoded ECDSA signature to the raw r||s format
 * required by RFC 7518 ES256 (each component padded to 32 bytes).
 */
function derToRawEs256(derSig) {
  let offset = 2 // skip 0x30 (SEQUENCE) and total-length byte
  const rLen = derSig[offset + 1]
  let r = derSig.slice(offset + 2, offset + 2 + rLen)
  if (r[0] === 0x00) r = r.slice(1) // strip DER positive-integer sentinel

  offset += 2 + rLen
  const sLen = derSig[offset + 1]
  let s = derSig.slice(offset + 2, offset + 2 + sLen)
  if (s[0] === 0x00) s = s.slice(1)

  const rPad = Buffer.alloc(32)
  r.copy(rPad, 32 - r.length)
  const sPad = Buffer.alloc(32)
  s.copy(sPad, 32 - s.length)
  return Buffer.concat([rPad, sPad])
}

function signEs256Jwt(privateKey, header, payload) {
  const headerB64 = base64url(JSON.stringify(header))
  const payloadB64 = base64url(JSON.stringify(payload))
  const sigInput = `${headerB64}.${payloadB64}`
  const sign = createSign('SHA256')
  sign.update(sigInput)
  const derSig = sign.sign(privateKey)
  return `${sigInput}.${derToRawEs256(derSig).toString('base64url')}`
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const CLI = resolve(REPO_ROOT, 'packages/mcp-server/dist/cli/index.js')

if (!existsSync(CLI)) {
  console.error(
    '[server-run-smoke] FAIL: dist/cli/index.js missing.\n' +
      'Run `pnpm --filter @kamiazya/whiteboard-mcp build` before this smoke.',
  )
  process.exit(1)
}

const SENSITIVE_TOKEN = 'smoke-secret-jwks-token-xyz-789'
const SENSITIVE_URL = 'https://super-secret-auth.internal'

/**
 * Generate a self-signed TLS certificate for 127.0.0.1 using openssl.
 * The cert is written to `dir` and returned for use with NODE_EXTRA_CA_CERTS.
 * Node.js >=22 respects NODE_EXTRA_CA_CERTS in undici-based fetch, so the
 * spawned server process can reach the HTTPS JWKS mock without disabling TLS
 * verification globally.
 */
function generateTestTlsCert(dir) {
  const keyFile = join(dir, 'tls-key.pem')
  const certFile = join(dir, 'tls-cert.pem')
  const cnfFile = join(dir, 'openssl.cnf')
  writeFileSync(
    cnfFile,
    [
      '[req]',
      'distinguished_name = req_dn',
      'x509_extensions = san_ext',
      'prompt = no',
      '',
      '[req_dn]',
      'CN = smoke-test-jwks-ca',
      '',
      '[san_ext]',
      'subjectAltName = IP:127.0.0.1',
      'basicConstraints = critical,CA:true',
    ].join('\n'),
  )
  const r = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-keyout',
      keyFile,
      '-out',
      certFile,
      '-days',
      '1',
      '-nodes',
      '-config',
      cnfFile,
    ],
    { stdio: 'pipe', encoding: 'utf8' },
  )
  if (r.status !== 0) throw new Error(`openssl cert gen failed: ${r.stderr}`)
  return { keyFile, certFile }
}

function fail(msg, ctx = {}) {
  console.error(`[server-run-smoke] FAIL: ${msg}`)
  for (const [k, v] of Object.entries(ctx)) {
    if (v !== undefined && v !== '') {
      console.error(`  ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    }
  }
  process.exit(1)
}

// assertNoLeakHelper (BASE_LEAK_PATTERNS) is imported from smoke-helpers.mjs.
// SENSITIVE_TOKEN and SENSITIVE_URL are dynamic values passed as extraLiterals.
function assertNoLeak(label, text) {
  assertNoLeakHelper(label, text, [SENSITIVE_TOKEN, SENSITIVE_URL])
}

function runCli(args, { env } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    env: { ...scrubDevEnv(process.env), ...env },
    encoding: 'utf8',
    // `server stop` can itself wait up to 10s (DEFAULT_STOP_TIMEOUT_MS in
    // server-stop.ts) for the child process to exit before escalating to
    // SIGKILL. A CLI timeout equal to that budget races it — bump ours to
    // leave real headroom over the production-side wait.
    timeout: 15_000,
  })
}

// Async twin of runCli, for CLI invocations that must fetch a JWKS mock
// hosted in THIS same process (server doctor's server.jwks check). spawnSync
// blocks this process's event loop for the child's whole lifetime, so the
// parent can never service the child's incoming connection to its own mock
// server — a self-deadlock the child's fetch only escapes by timing out.
// spawn() keeps the event loop running, so the mock server can actually
// answer while the child waits. Mirrors runCli's { status, stdout, stderr }
// shape so call sites need no other changes.
function runCliAsync(args, { env, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...scrubDevEnv(process.env), ...env },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }, timeoutMs)
    child.once('close', (status) => {
      clearTimeout(timer)
      resolve({ status, stdout, stderr })
    })
  })
}

const REQUIRED_FLAGS = [
  '--auth-strategy=oauth-jwt',
  '--jwt-issuer=https://auth.example.com',
  '--jwt-audience=https://whiteboard.example.com',
  `--jwks-uri=https://auth.example.com/.well-known/jwks.json`,
]

// Scenario 1: non-HTTPS externalUrl → plan rejects → exit 1
{
  const r = runCli([
    'server',
    'run',
    '--json',
    '--dry-run',
    '--external-url=http://whiteboard.example.com',
    ...REQUIRED_FLAGS,
  ])
  if (r.status !== 1)
    fail(`scenario 1: expected exit 1, got ${r.status}`, { stderrBytes: r.stderr.length })
  if (r.stdout.trim() !== '')
    fail('scenario 1: stdout must be empty', { lineLength: r.stdout.length })
  assertNoLeak('scenario 1 stderr', r.stderr)
  console.log('[server-run-smoke] scenario 1 PASS: non-HTTPS externalUrl → exit 1, stderr safe')
}

// Scenario 2: valid dry-run → exit 0, stdout single JSON, fields correct
{
  const r = runCli([
    'server',
    'run',
    '--json',
    '--dry-run',
    '--external-url=https://whiteboard.example.com',
    ...REQUIRED_FLAGS,
  ])
  if (r.status !== 0)
    fail(`scenario 2: expected exit 0, got ${r.status}`, { stderrBytes: r.stderr.length })
  if (r.stderr.trim() !== '')
    fail('scenario 2: stderr must be empty', { stderrBytes: r.stderr.length })
  let obj
  try {
    obj = JSON.parse(r.stdout)
  } catch {
    fail('scenario 2: stdout not valid JSON', { lineLength: r.stdout.length })
  }
  if (obj.schemaVersion !== 1) fail('scenario 2: schemaVersion must be 1')
  if (obj.ok !== true) fail('scenario 2: ok must be true')
  if (obj.dryRun !== true) fail('scenario 2: dryRun must be true')
  if (obj.publicBaseUrl !== 'https://whiteboard.example.com')
    fail(`scenario 2: publicBaseUrl wrong: ${obj.publicBaseUrl}`)
  if (obj.authStrategy !== 'oauth-jwt') fail('scenario 2: authStrategy must be oauth-jwt')
  if (!Array.isArray(obj.allowedOrigins)) fail('scenario 2: allowedOrigins must be array')
  // Trailing newline check: exactly one JSON object
  const lines = r.stdout.trim().split('\n')
  if (lines.length !== 1) fail(`scenario 2: stdout must be exactly one line, got ${lines.length}`)
  console.log('[server-run-smoke] scenario 2 PASS: valid dry-run → exit 0, JSON shape correct')
}

// Scenario 3: origin normalization https://whiteboard.example.com:443 → https://whiteboard.example.com
{
  const r = runCli([
    'server',
    'run',
    '--json',
    '--dry-run',
    '--external-url=https://whiteboard.example.com',
    '--allowed-origins=https://whiteboard.example.com:443',
    ...REQUIRED_FLAGS,
  ])
  if (r.status !== 0)
    fail(`scenario 3: expected exit 0, got ${r.status}`, { stderrBytes: r.stderr.length })
  const obj = JSON.parse(r.stdout)
  if (!Array.isArray(obj.allowedOrigins)) fail('scenario 3: allowedOrigins must be array')
  if (obj.allowedOrigins.some((o) => o.includes(':443')))
    fail(`scenario 3: :443 not stripped from allowedOrigins: ${JSON.stringify(obj.allowedOrigins)}`)
  if (!obj.allowedOrigins.includes('https://whiteboard.example.com'))
    fail(`scenario 3: expected https://whiteboard.example.com in allowedOrigins`)
  console.log('[server-run-smoke] scenario 3 PASS: :443 normalized in allowedOrigins')
}

// Scenario 4: wildcard origin → config-error → exit 1, stderr safe
{
  const r = runCli([
    'server',
    'run',
    '--json',
    '--dry-run',
    '--external-url=https://whiteboard.example.com',
    '--allowed-origins=*',
    ...REQUIRED_FLAGS,
  ])
  if (r.status !== 1)
    fail(`scenario 4: expected exit 1, got ${r.status}`, { stderrBytes: r.stderr.length })
  if (r.stdout.trim() !== '') fail('scenario 4: stdout must be empty')
  assertNoLeak('scenario 4 stderr', r.stderr)
  console.log('[server-run-smoke] scenario 4 PASS: wildcard origin → exit 1, stderr safe')
}

// Scenario 5: unknown server subcommand → exit 64, USAGE lists whiteboard server run
{
  const r = runCli(['server', 'unknown-subcommand'])
  if (r.status !== 64) fail(`scenario 5: expected exit 64, got ${r.status}`)
  if (r.stdout.trim() !== '') fail('scenario 5: stdout must be empty')
  if (!r.stderr.includes('whiteboard server run'))
    fail('scenario 5: USAGE must include "whiteboard server run"', { stderrBytes: r.stderr.length })
  console.log('[server-run-smoke] scenario 5 PASS: unknown subcommand → exit 64, USAGE correct')
}

// Scenario 6: missing --json → exit 64, stdout empty
{
  const r = runCli([
    'server',
    'run',
    '--dry-run',
    '--external-url=https://whiteboard.example.com',
    ...REQUIRED_FLAGS,
  ])
  if (r.status !== 64) fail(`scenario 6: expected exit 64, got ${r.status}`)
  if (r.stdout.trim() !== '') fail('scenario 6: stdout must be empty')
  console.log('[server-run-smoke] scenario 6 PASS: missing --json → exit 64')
}

// Scenario 7: CLI flags override env vars
{
  const r = runCli(
    [
      'server',
      'run',
      '--json',
      '--dry-run',
      '--external-url=https://cli-override.example.com',
      ...REQUIRED_FLAGS,
    ],
    {
      env: {
        WHITEBOARD_SERVER_EXTERNAL_URL: 'https://env-original.example.com',
        WHITEBOARD_SERVER_AUTH_STRATEGY: 'oauth-jwt',
        WHITEBOARD_SERVER_JWT_ISSUER: 'https://auth.example.com',
        WHITEBOARD_SERVER_JWT_AUDIENCE: 'https://whiteboard.example.com',
        WHITEBOARD_SERVER_JWKS_URI: 'https://auth.example.com/.well-known/jwks.json',
      },
    },
  )
  if (r.status !== 0)
    fail(`scenario 7: expected exit 0, got ${r.status}`, { stderrBytes: r.stderr.length })
  const obj = JSON.parse(r.stdout)
  if (obj.publicBaseUrl !== 'https://cli-override.example.com')
    fail(`scenario 7: CLI flag did not override env, got ${obj.publicBaseUrl}`)
  console.log('[server-run-smoke] scenario 7 PASS: CLI flags override env vars')
}

// Scenario 8: actual server run with local JWKS mock — full auth contract
// Port 4290 is dedicated to this smoke.
{
  const SERVER_PORT = 4290
  const SERVER_HOST = '127.0.0.1'
  const SMOKE_ISSUER = 'https://auth.smoke.example'
  const SMOKE_AUDIENCE = 'https://whiteboard.smoke.example'
  const READINESS_TIMEOUT_MS = 30_000
  const SHUTDOWN_TIMEOUT_MS = 10_000

  const dataDir = mkdtempSync(join(tmpdir(), 'whiteboard-server-smoke-s8-'))
  const { keyFile: tlsKeyFile, certFile: tlsCertFile } = generateTestTlsCert(dataDir)
  const tlsKey = readFileSync(tlsKeyFile)
  const tlsCert = readFileSync(tlsCertFile)

  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwkPublic = publicKey.export({ format: 'jwk' })
  const jwks = { keys: [{ ...jwkPublic, kid: 'smoke-key', use: 'sig', alg: 'ES256' }] }

  // Start local HTTPS JWKS mock server with the self-signed cert.
  const jwksServer = createHttpsServer({ key: tlsKey, cert: tlsCert }, (req, res) => {
    if (req.url === '/.well-known/jwks.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(jwks))
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise((resolve, reject) => {
    jwksServer.listen(0, '127.0.0.1', () => resolve())
    jwksServer.once('error', reject)
  })
  const jwksPort = jwksServer.address().port
  const jwksUri = `https://127.0.0.1:${jwksPort}/.well-known/jwks.json`

  let stdoutBuf = ''
  let stderrBuf = ''
  let firstLineResolve
  const firstLine = new Promise((r) => {
    firstLineResolve = r
  })

  const child = spawn(
    process.execPath,
    [
      CLI,
      'server',
      'run',
      '--json',
      `--external-url=${SMOKE_AUDIENCE}`,
      '--auth-strategy=oauth-jwt',
      `--jwt-issuer=${SMOKE_ISSUER}`,
      `--jwt-audience=${SMOKE_AUDIENCE}`,
      `--jwks-uri=${jwksUri}`,
      `--host=${SERVER_HOST}`,
      `--port=${SERVER_PORT}`,
    ],
    {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...scrubDevEnv(process.env),
        WHITEBOARD_DATA_DIR: dataDir,
        // Trust the self-signed CA so jose's createRemoteJWKSet (undici/fetch)
        // can reach the HTTPS JWKS mock. NODE_EXTRA_CA_CERTS works with undici
        // in Node.js >=22 (the project's minimum engine requirement).
        NODE_EXTRA_CA_CERTS: tlsCertFile,
      },
    },
  )

  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString()
    const nl = stdoutBuf.indexOf('\n')
    if (nl !== -1) firstLineResolve(stdoutBuf.slice(0, nl))
  })
  child.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString()
  })
  const closed = new Promise((r) => child.once('close', r))

  const shutdown = async () => {
    if (child.exitCode !== null) return
    try {
      child.kill('SIGTERM')
    } catch {
      /* gone */
    }
    await Promise.race([closed, delay(SHUTDOWN_TIMEOUT_MS)])
    try {
      child.kill('SIGKILL')
    } catch {
      /* gone */
    }
    await closed
  }

  try {
    const winner = await Promise.race([firstLine, delay(READINESS_TIMEOUT_MS, 'timeout')])
    if (winner === 'timeout') {
      await shutdown()
      fail('scenario 8: server did not emit ready JSON within timeout', {
        stderrBytes: stderrBuf.length,
      })
    }

    let ready
    try {
      ready = JSON.parse(winner)
    } catch {
      fail('scenario 8: first stdout line not valid JSON', {
        lineLength: typeof winner === 'string' ? winner.length : -1,
      })
    }

    // Ready JSON shape contract
    if (ready.ok !== true) fail('scenario 8: ready.ok not true', { ready })
    if (ready.schemaVersion !== 1) fail('scenario 8: ready.schemaVersion not 1')
    if (typeof ready.pid !== 'number') fail('scenario 8: ready.pid not a number')
    if (ready.publicBaseUrl !== SMOKE_AUDIENCE)
      fail(`scenario 8: publicBaseUrl wrong: ${ready.publicBaseUrl}`)
    if (ready.authStrategy !== 'oauth-jwt') fail('scenario 8: authStrategy must be oauth-jwt')
    if (typeof ready.startedAt !== 'string') fail('scenario 8: startedAt must be a string')
    if (typeof ready.host !== 'string') fail('scenario 8: host must be a string')
    if (typeof ready.port !== 'number') fail('scenario 8: port must be a number')

    // Exactly one line
    const lines = stdoutBuf.trim().split('\n')
    if (lines.length !== 1) fail(`scenario 8: stdout must be exactly one line, got ${lines.length}`)

    assertNoLeak('scenario 8 stdout', stdoutBuf)
    assertNoLeak('scenario 8 stderr', stderrBuf)

    // Small delay to ensure the server is accepting connections
    await delay(300)

    const baseUrl = `http://${SERVER_HOST}:${SERVER_PORT}`

    // /api/runtime/ping is public
    const pingResp = await fetch(`${baseUrl}/api/runtime/ping`)
    if (pingResp.status !== 200)
      fail(`scenario 8: /api/runtime/ping expected 200, got ${pingResp.status}`)
    const pingBody = await pingResp.json()
    if (pingBody.ok !== true) fail('scenario 8: ping.ok must be true')
    // daemonPingResponseSchema (shared/api-contracts/runtime.ts) deliberately
    // carries instanceId, not pid: an OS pid is reused across processes, so a
    // stale record comparing pid alone could misidentify an unrelated process
    // as this server. instanceId is unique per start and never reused.
    if (typeof pingBody.instanceId !== 'string') {
      fail('scenario 8: ping.instanceId must be a string')
    }

    // Protected route with no auth → 401
    const noAuthResp = await fetch(`${baseUrl}/api/canvas/test-ws/test-canvas/viewport`)
    if (noAuthResp.status !== 401)
      fail(`scenario 8: no-auth protected route expected 401, got ${noAuthResp.status}`)
    const noAuthBody = await noAuthResp.text()
    assertNoLeak('scenario 8 no-auth response body', noAuthBody)

    // Valid JWT with correct scope → auth passes (not 401 or 403)
    const now = Math.floor(Date.now() / 1000)
    const validJwt = signEs256Jwt(
      privateKey,
      { alg: 'ES256', kid: 'smoke-key' },
      {
        sub: 'smoke-user',
        scope: 'canvas:read',
        iss: SMOKE_ISSUER,
        aud: SMOKE_AUDIENCE,
        iat: now,
        exp: now + 3600,
      },
    )
    const authResp = await fetch(`${baseUrl}/api/canvas/test-ws/test-canvas/viewport`, {
      headers: { Authorization: `Bearer ${validJwt}` },
    })
    if (authResp.status === 401 || authResp.status === 403)
      fail(`scenario 8: valid JWT should pass auth, got ${authResp.status}`)
    const authBody = await authResp.text()
    assertNoLeak('scenario 8 auth response body', authBody)
    if (authBody.includes(validJwt)) fail('scenario 8: JWT leaked to response body')

    // JWT with wrong scope → 403
    const wrongScopeJwt = signEs256Jwt(
      privateKey,
      { alg: 'ES256', kid: 'smoke-key' },
      {
        sub: 'smoke-user',
        scope: 'workspace:read',
        iss: SMOKE_ISSUER,
        aud: SMOKE_AUDIENCE,
        iat: now,
        exp: now + 3600,
      },
    )
    const scopeResp = await fetch(`${baseUrl}/api/canvas/test-ws/test-canvas/viewport`, {
      headers: { Authorization: `Bearer ${wrongScopeJwt}` },
    })
    if (scopeResp.status !== 403)
      fail(`scenario 8: wrong scope expected 403, got ${scopeResp.status}`)

    console.log(
      '[server-run-smoke] scenario 8 PASS: server starts, ready JSON correct, auth contract verified',
    )

    // Scenario 9: server status while running → ok:true, state:running, fields match ready JSON
    {
      const r = runCli(['server', 'status', '--json', `--data-dir=${dataDir}`])
      if (r.status !== 0) fail('scenario 9: expected exit 0', { stderrBytes: r.stderr.length })
      let obj
      try {
        obj = JSON.parse(r.stdout)
      } catch {
        fail('scenario 9: stdout not valid JSON', { lineLength: r.stdout.length })
      }
      if (obj.state !== 'running') fail(`scenario 9: expected state:running, got ${obj.state}`)
      if (obj.ok !== true) fail('scenario 9: ok must be true')
      if (obj.pid !== ready.pid) fail(`scenario 9: pid mismatch: ${obj.pid} vs ${ready.pid}`)
      if (obj.port !== ready.port) fail(`scenario 9: port mismatch: ${obj.port} vs ${ready.port}`)
      if (obj.publicBaseUrl !== SMOKE_AUDIENCE)
        fail(`scenario 9: publicBaseUrl wrong: ${obj.publicBaseUrl}`)
      if (obj.recordFresh !== true) fail('scenario 9: recordFresh must be true')
      assertNoLeak('scenario 9 status stdout', r.stdout)
      console.log('[server-run-smoke] scenario 9 PASS: status while running → correct fields')
    }

    // Scenario 10: server stop while running → ok:true, action:stopped
    {
      const r = runCli(['server', 'stop', '--json', `--data-dir=${dataDir}`])
      if (r.status !== 0) fail('scenario 10: expected exit 0', { stderrBytes: r.stderr.length })
      let obj
      try {
        obj = JSON.parse(r.stdout)
      } catch {
        fail('scenario 10: stdout not valid JSON', { lineLength: r.stdout.length })
      }
      if (obj.action !== 'stopped') fail(`scenario 10: expected action:stopped, got ${obj.action}`)
      if (obj.ok !== true) fail('scenario 10: ok must be true')
      if (obj.pid !== ready.pid) fail(`scenario 10: pid mismatch: ${obj.pid} vs ${ready.pid}`)
      assertNoLeak('scenario 10 stop stdout', r.stdout)
      console.log('[server-run-smoke] scenario 10 PASS: stop while running → stopped')
    }

    // Wait for server process to fully exit (stop command polls until PID is dead,
    // so closed should already be resolved here, but await for safety).
    await closed

    // Scenario 11: server status after stop → ok:false, state:missing
    {
      const r = runCli(['server', 'status', '--json', `--data-dir=${dataDir}`])
      if (r.status !== 1) fail(`scenario 11: expected exit 1, got ${r.status}`)
      let obj
      try {
        obj = JSON.parse(r.stdout)
      } catch {
        fail('scenario 11: stdout not valid JSON', { lineLength: r.stdout.length })
      }
      if (obj.state !== 'missing') fail(`scenario 11: expected state:missing, got ${obj.state}`)
      if (obj.ok !== false) fail('scenario 11: ok must be false')
      assertNoLeak('scenario 11 status-after-stop stdout', r.stdout)
      console.log('[server-run-smoke] scenario 11 PASS: status after stop → missing')
    }
  } finally {
    await shutdown()
    await new Promise((resolve) => jwksServer.close(resolve))
    rmSync(dataDir, { recursive: true, force: true })
  }
}

// Scenario 12: server status with no server record → ok:false, state:missing, exit 1
{
  const dataDir = mkdtempSync(join(tmpdir(), 'whiteboard-server-smoke-s12-'))
  try {
    const r = runCli(['server', 'status', '--json', `--data-dir=${dataDir}`])
    if (r.status !== 1)
      fail(`scenario 12: expected exit 1, got ${r.status}`, { stderrBytes: r.stderr.length })
    if (r.stdout.trim() === '') fail('scenario 12: stdout must not be empty (expected JSON)')
    let obj
    try {
      obj = JSON.parse(r.stdout)
    } catch {
      fail('scenario 12: stdout not valid JSON', { lineLength: r.stdout.length })
    }
    if (obj.state !== 'missing') fail(`scenario 12: expected state:missing, got ${obj.state}`)
    if (obj.ok !== false) fail('scenario 12: ok must be false')
    assertNoLeak('scenario 12 output', r.stdout)
    console.log('[server-run-smoke] scenario 12 PASS: status no record → missing, exit 1')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
}

// Scenario 13: server stop with no server record → ok:true, action:not-running, exit 0
{
  const dataDir = mkdtempSync(join(tmpdir(), 'whiteboard-server-smoke-s13-'))
  try {
    const r = runCli(['server', 'stop', '--json', `--data-dir=${dataDir}`])
    if (r.status !== 0)
      fail(`scenario 13: expected exit 0, got ${r.status}`, { stderrBytes: r.stderr.length })
    let obj
    try {
      obj = JSON.parse(r.stdout)
    } catch {
      fail('scenario 13: stdout not valid JSON', { lineLength: r.stdout.length })
    }
    if (obj.action !== 'not-running')
      fail(`scenario 13: expected action:not-running, got ${obj.action}`)
    if (obj.ok !== true) fail('scenario 13: ok must be true')
    assertNoLeak('scenario 13 output', r.stdout)
    console.log('[server-run-smoke] scenario 13 PASS: stop no record → not-running, exit 0')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
}

// Scenarios 14–16: server doctor --json. Share one HTTPS JWKS mock to
// limit TLS cert generation overhead. JWKS mock uses port 0 (OS-assigned).
{
  const { publicKey: drPublicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const drJwks = {
    keys: [{ ...drPublicKey.export({ format: 'jwk' }), kid: 'dr-key', use: 'sig', alg: 'ES256' }],
  }
  const drCertsDir = mkdtempSync(join(tmpdir(), 'whiteboard-doctor-smoke-certs-'))
  const { keyFile: drKeyFile, certFile: drCertFile } = generateTestTlsCert(drCertsDir)
  const drTlsKey = readFileSync(drKeyFile)
  const drTlsCert = readFileSync(drCertFile)

  const drJwksServer = await new Promise((resolve, reject) => {
    const srv = createHttpsServer({ key: drTlsKey, cert: drTlsCert }, (req, res) => {
      if (req.url === '/.well-known/jwks.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(drJwks))
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    srv.listen(0, '127.0.0.1', () => resolve(srv))
    srv.once('error', reject)
  })
  const drJwksPort = drJwksServer.address().port
  const drJwksUri = `https://127.0.0.1:${drJwksPort}/.well-known/jwks.json`
  const DOCTOR_FLAGS = [
    '--external-url=https://whiteboard.example.com',
    '--auth-strategy=oauth-jwt',
    '--jwt-issuer=https://smoke.example.com',
    '--jwt-audience=https://whiteboard.example.com',
    `--jwks-uri=${drJwksUri}`,
  ]

  try {
    // Scenario 14: valid config + HTTPS JWKS mock, no record → exit 0, ok:true
    {
      const dataDir = mkdtempSync(join(tmpdir(), 'whiteboard-server-smoke-s14-'))
      try {
        const r = await runCliAsync(
          ['server', 'doctor', '--json', `--data-dir=${dataDir}`, ...DOCTOR_FLAGS],
          { env: { NODE_EXTRA_CA_CERTS: drCertFile } },
        )
        if (r.status !== 0)
          fail(`scenario 14: expected exit 0, got ${r.status}`, { stderrBytes: r.stderr.length })
        if (r.stderr.trim() !== '')
          fail('scenario 14: stderr must be empty', { stderrBytes: r.stderr.length })
        let obj
        try {
          obj = JSON.parse(r.stdout)
        } catch {
          fail('scenario 14: stdout not valid JSON', { lineLength: r.stdout.length })
        }
        if (obj.ok !== true) fail(`scenario 14: ok must be true, got ok:${obj.ok}`)
        if (obj.schemaVersion !== 1) fail('scenario 14: schemaVersion must be 1')
        if (!Array.isArray(obj.checks)) fail('scenario 14: checks must be array')
        const jwksCheck = obj.checks.find((c) => c.id === 'server.jwks')
        if (!jwksCheck) fail('scenario 14: server.jwks check missing')
        if (jwksCheck.status !== 'ok')
          fail(`scenario 14: expected server.jwks ok, got ${jwksCheck.status}`)
        if (obj.status !== 'ok')
          fail(`scenario 14: expected status:ok (no warnings), got ${obj.status}`)
        const badCheck = obj.checks.find((c) => c.status !== 'ok' && c.status !== 'skipped')
        if (badCheck)
          fail(
            `scenario 14: all checks must be ok or skipped, got ${badCheck.id}:${badCheck.status}`,
          )
        assertNoLeak('scenario 14 stdout', r.stdout)
        console.log(
          '[server-run-smoke] scenario 14 PASS: doctor valid config + JWKS → exit 0, ok:true',
        )
      } finally {
        rmSync(dataDir, { recursive: true, force: true })
      }
    }

    // Scenario 15: non-HTTPS externalUrl → at least one error check → exit 1, ok:false, stderr safe
    {
      const dataDir = mkdtempSync(join(tmpdir(), 'whiteboard-server-smoke-s15-'))
      try {
        const r = await runCliAsync(
          [
            'server',
            'doctor',
            '--json',
            `--data-dir=${dataDir}`,
            '--external-url=http://not-https.example.com',
            '--auth-strategy=oauth-jwt',
            '--jwt-issuer=https://smoke.example.com',
            '--jwt-audience=https://whiteboard.example.com',
            `--jwks-uri=${drJwksUri}`,
          ],
          { env: { NODE_EXTRA_CA_CERTS: drCertFile } },
        )
        if (r.status !== 1)
          fail(`scenario 15: expected exit 1, got ${r.status}`, { stderrBytes: r.stderr.length })
        if (r.stdout.trim() === '') fail('scenario 15: stdout must not be empty')
        let obj
        try {
          obj = JSON.parse(r.stdout)
        } catch {
          fail('scenario 15: stdout not valid JSON', { lineLength: r.stdout.length })
        }
        if (obj.ok !== false) fail('scenario 15: ok must be false')
        if (!obj.checks?.some((c) => c.status === 'error'))
          fail('scenario 15: at least one check must have error status')
        if (r.stdout.includes('not-https.example.com'))
          fail('scenario 15: stdout must not contain raw externalUrl')
        if (r.stderr.trim() !== '')
          fail('scenario 15: stderr must be empty', { stderrBytes: r.stderr.length })
        assertNoLeak('scenario 15 stdout', r.stdout)
        assertNoLeak('scenario 15 stderr', r.stderr)
        console.log(
          '[server-run-smoke] scenario 15 PASS: invalid config → exit 1, ok:false, stderr safe',
        )
      } finally {
        rmSync(dataDir, { recursive: true, force: true })
      }
    }

    // Scenario 16: stale server record with broad permissions → server.identity skipped,
    // server.record_permissions warning on POSIX, no crash, exit 0
    {
      const dataDir = mkdtempSync(join(tmpdir(), 'whiteboard-server-smoke-s16-'))
      try {
        const staleRecord = {
          schemaVersion: 1,
          pid: 99999999,
          host: '127.0.0.1',
          port: 4299,
          publicBaseUrl: 'https://whiteboard.example.com',
          authStrategy: 'oauth-jwt',
          startedAt: '2026-05-19T00:00:00.000Z',
        }
        const recordPath = join(dataDir, 'server-mode.json')
        writeFileSync(recordPath, JSON.stringify(staleRecord))
        // chmodSync bypasses umask to reliably set broad permissions.
        chmodSync(recordPath, 0o644)
        const r = await runCliAsync(
          ['server', 'doctor', '--json', `--data-dir=${dataDir}`, ...DOCTOR_FLAGS],
          { env: { NODE_EXTRA_CA_CERTS: drCertFile } },
        )
        if (r.status === null) fail('scenario 16: doctor process was killed by signal')
        if (r.status !== 0)
          fail(`scenario 16: expected exit 0, got ${r.status}`, { stderrBytes: r.stderr.length })
        if (r.stdout.trim() === '') fail('scenario 16: stdout must not be empty')
        let obj
        try {
          obj = JSON.parse(r.stdout)
        } catch {
          fail('scenario 16: stdout not valid JSON', { lineLength: r.stdout.length })
        }
        if (!Array.isArray(obj.checks)) fail('scenario 16: checks must be array')
        const recordCheck = obj.checks.find((c) => c.id === 'server.record')
        if (!recordCheck) fail('scenario 16: server.record check missing')
        if (recordCheck.status !== 'ok')
          fail(`scenario 16: expected server.record ok, got ${recordCheck.status}`)
        const identityCheck = obj.checks.find((c) => c.id === 'server.identity')
        if (!identityCheck) fail('scenario 16: server.identity check missing')
        if (identityCheck.status !== 'skipped')
          fail(`scenario 16: expected server.identity skipped, got ${identityCheck.status}`)
        if (process.platform !== 'win32') {
          const permCheck = obj.checks.find((c) => c.id === 'server.record_permissions')
          if (!permCheck) fail('scenario 16: server.record_permissions check missing')
          if (permCheck.status !== 'warning')
            fail(`scenario 16: expected server.record_permissions warning, got ${permCheck.status}`)
        }
        assertNoLeak('scenario 16 stdout', r.stdout)
        console.log(
          '[server-run-smoke] scenario 16 PASS: stale record → identity skipped, permissions warning',
        )
      } finally {
        rmSync(dataDir, { recursive: true, force: true })
      }
    }
  } finally {
    await new Promise((resolve) => drJwksServer.close(resolve))
    rmSync(drCertsDir, { recursive: true, force: true })
  }
}

// Regression: local daemon routing unchanged (unknown command still exits 64)
{
  const r = runCli(['daemon', 'unknown-subcommand', '--json'])
  if (r.status !== 64)
    fail(`regression: daemon unknown subcommand should still exit 64, got ${r.status}`)
  console.log('[server-run-smoke] regression PASS: daemon routing unchanged')
}

console.log('[server-run-smoke] All scenarios PASSED.')
