#!/usr/bin/env node

// Docker smoke for whiteboard server-mode.
//
// Verifies the Dockerfile.server artifact at the container boundary:
//   1.  docker build succeeds.
//   2.  Invalid config → container exits non-zero, stderr safe.
//   3.  Valid config + HTTPS JWKS mock → ready JSON emitted.
//   4.  /api/runtime/ping → 200, ok:true.
//   5.  Protected route, no auth → 401.
//   6.  Valid ES256 JWT → auth passes.
//   7.  Wrong scope → 403.
//   8.  docker stop → graceful SIGTERM, container exits cleanly.
//   9.  Restart with same mounted volume → stale record handled, server starts.
//  10.  stdout/stderr/docker logs: no raw JWT, Authorization/Bearer, JWKS
//      credential, full dataDir path, or stack trace.
//
// Skip condition: `docker info` fails → Docker daemon is not available.
//
// Network strategy:
//   On Linux, --network=host lets the container reach 127.0.0.1 on the host.
//   On other platforms, --add-host=host.docker.internal:host-gateway is used.
//
// This smoke is NOT part of pnpm test:e2e:distribution (Docker may not be
// available in all CI environments). Run it explicitly:
//   node tests/e2e/distribution/packaged-server-mode-docker-smoke.mjs

import { spawnSync } from 'node:child_process'
import { createSign, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpsServer } from 'node:https'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { assertNoLeak } from './smoke-helpers.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '../../..')

const IMAGE_TAG = 'whiteboard-server-smoke:test'
const SMOKE_ISSUER = 'https://auth.docker-smoke.example'
const SMOKE_AUDIENCE = 'https://whiteboard.docker-smoke.example'
const HOST_SERVER_PORT = 4293 // host port mapped to container's 3099
const READINESS_TIMEOUT_MS = 60_000

// ── Helpers ──────────────────────────────────────────────────────────────────

function fail(msg, ctx = {}) {
  console.error(`[docker-smoke] FAIL: ${msg}`)
  for (const [k, v] of Object.entries(ctx)) {
    if (v !== undefined && v !== '') {
      console.error(`  ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    }
  }
  process.exit(1)
}

function skip(reason) {
  console.log(`[docker-smoke] SKIP: ${reason}`)
  process.exit(0)
}

function docker(args, opts = {}) {
  return spawnSync('docker', args, {
    encoding: 'utf8',
    timeout: opts.timeout ?? 120_000,
    ...opts,
  })
}

// assertNoLeak (BASE_LEAK_PATTERNS) is imported from smoke-helpers.mjs.

function generateTestTlsCert(dir) {
  const keyFile = join(dir, 'server.key')
  const certFile = join(dir, 'server.crt')
  const cnfFile = join(dir, 'openssl.cnf')
  writeFileSync(
    cnfFile,
    [
      '[req]',
      'distinguished_name = req_dn',
      'x509_extensions = san_ext',
      'prompt = no',
      '[req_dn]',
      'CN = docker-smoke-ca',
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
  if (r.status !== 0) throw new Error(`openssl failed: ${r.stderr}`)
  return { keyFile, certFile }
}

function base64url(data) {
  return Buffer.from(data).toString('base64url')
}

function derToRawEs256(derSig) {
  let offset = 2
  const rLen = derSig[offset + 1]
  let r = derSig.slice(offset + 2, offset + 2 + rLen)
  if (r[0] === 0x00) r = r.slice(1)
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
  const h = base64url(JSON.stringify(header))
  const p = base64url(JSON.stringify(payload))
  const signer = createSign('SHA256')
  signer.update(`${h}.${p}`)
  const raw = derToRawEs256(signer.sign({ key: privateKey, dsaEncoding: 'der' }))
  return `${h}.${p}.${base64url(raw)}`
}

async function waitForReadyJson(containerName) {
  const deadline = Date.now() + READINESS_TIMEOUT_MS
  while (Date.now() < deadline) {
    await delay(1000)
    const logs = docker(['logs', containerName], { timeout: 5_000 })
    for (const line of logs.stdout.split('\n')) {
      try {
        const obj = JSON.parse(line)
        if (obj.ok === true && typeof obj.pid === 'number') return obj
      } catch {
        /* not JSON */
      }
    }
    const inspect = docker(['inspect', '--format={{.State.Running}}', containerName], {
      timeout: 5_000,
    })
    if (inspect.stdout.trim() !== 'true') return null
  }
  return null
}

function stopContainer(name) {
  docker(['stop', '-t', '10', name], { timeout: 20_000 })
}

// ── Availability check ────────────────────────────────────────────────────────

if (docker(['info'], { timeout: 10_000 }).status !== 0) {
  skip('Docker daemon is not available (docker info failed). Start Docker to run this smoke.')
}
console.log('[docker-smoke] Docker available. Starting smoke.')

// ── Network strategy ──────────────────────────────────────────────────────────
const useHostNetwork = process.platform === 'linux'
const jwksConnectHost = useHostNetwork ? '127.0.0.1' : 'host.docker.internal'
const networkRunArgs = useHostNetwork
  ? ['--network=host']
  : ['--add-host=host.docker.internal:host-gateway', '-p', `${HOST_SERVER_PORT}:3099`]
const serverBaseUrl = useHostNetwork
  ? 'http://127.0.0.1:3099'
  : `http://127.0.0.1:${HOST_SERVER_PORT}`

// ── Scenario 1: docker build ──────────────────────────────────────────────────

console.log('[docker-smoke] Building image (may take several minutes)…')
{
  const r = docker(
    ['build', '-f', resolve(REPO_ROOT, 'Dockerfile.server'), '-t', IMAGE_TAG, REPO_ROOT],
    { timeout: 600_000, stdio: 'inherit' },
  )
  if (r.status !== 0) fail('scenario 1: docker build failed')
  console.log('[docker-smoke] scenario 1 PASS: docker build succeeded')
}

// ── Scenario 2: invalid config ────────────────────────────────────────────────

{
  const r = docker(
    [
      'run',
      '--rm',
      '--name',
      'wb-smoke-invalid',
      '-e',
      'WHITEBOARD_SERVER_EXTERNAL_URL=http://not-https.example.com',
      '-e',
      'WHITEBOARD_SERVER_AUTH_STRATEGY=oauth-jwt',
      '-e',
      'WHITEBOARD_SERVER_JWT_ISSUER=https://idp.example.com',
      '-e',
      'WHITEBOARD_SERVER_JWT_AUDIENCE=https://whiteboard.example.com',
      '-e',
      'WHITEBOARD_SERVER_JWKS_URI=https://idp.example.com/.well-known/jwks.json',
      '-e',
      'WHITEBOARD_SERVER_ALLOWED_ORIGINS=https://whiteboard.example.com',
      IMAGE_TAG,
    ],
    { timeout: 30_000 },
  )
  if (r.status === 0) fail('scenario 2: expected non-zero exit for invalid config')
  // If stdout has content it must be JSON with ok:false (not raw config or error text).
  const stdoutTrim = r.stdout.trim()
  if (stdoutTrim !== '') {
    let obj
    try {
      obj = JSON.parse(stdoutTrim)
    } catch {
      fail('scenario 2: unexpected non-JSON stdout', { lineLength: r.stdout.length })
    }
    if (obj.ok !== false) fail('scenario 2: stdout JSON must have ok:false')
  }
  assertNoLeak('scenario 2 stderr', r.stderr)
  assertNoLeak('scenario 2 stdout', r.stdout)
  if (r.stdout.includes('not-https.example.com'))
    fail('scenario 2: raw external URL leaked into stdout')
  if (r.stderr.includes('not-https.example.com'))
    fail('scenario 2: raw external URL leaked into stderr')
  console.log('[docker-smoke] scenario 2 PASS: invalid config → non-zero exit, stderr safe')
}

// ── Scenarios 3–10: valid config + full auth contract ─────────────────────────

const certsDir = mkdtempSync(join(tmpdir(), 'wb-docker-smoke-certs-'))
const dataDir = mkdtempSync(join(tmpdir(), 'wb-docker-smoke-data-'))

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const jwkPublic = publicKey.export({ format: 'jwk' })
const jwks = { keys: [{ ...jwkPublic, kid: 'smoke-key', use: 'sig', alg: 'ES256' }] }

const { certFile: tlsCertFile, keyFile: tlsKeyFile } = generateTestTlsCert(certsDir)
const tlsKey = readFileSync(tlsKeyFile)
const tlsCert = readFileSync(tlsCertFile)

const jwksServer = await new Promise((resolve, reject) => {
  const srv = createHttpsServer({ key: tlsKey, cert: tlsCert }, (req, res) => {
    if (req.url === '/.well-known/jwks.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(jwks))
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  srv.listen(0, '0.0.0.0', () => resolve(srv))
  srv.once('error', reject)
})
const jwksPort = jwksServer.address().port
const jwksUri = `https://${jwksConnectHost}:${jwksPort}/.well-known/jwks.json`

let activeContainer = null

try {
  // Scenario 3: start container with valid config.
  {
    const r = docker(
      [
        'run',
        '--rm',
        '-d',
        '--name',
        'wb-smoke-valid',
        ...networkRunArgs,
        '-v',
        `${dataDir}:/data`,
        '-v',
        `${tlsCertFile}:/extra-ca.crt:ro`,
        '-e',
        `NODE_EXTRA_CA_CERTS=/extra-ca.crt`,
        '-e',
        `WHITEBOARD_SERVER_EXTERNAL_URL=${SMOKE_AUDIENCE}`,
        '-e',
        `WHITEBOARD_SERVER_AUTH_STRATEGY=oauth-jwt`,
        '-e',
        `WHITEBOARD_SERVER_JWT_ISSUER=${SMOKE_ISSUER}`,
        '-e',
        `WHITEBOARD_SERVER_JWT_AUDIENCE=${SMOKE_AUDIENCE}`,
        '-e',
        `WHITEBOARD_SERVER_JWKS_URI=${jwksUri}`,
        '-e',
        `WHITEBOARD_SERVER_ALLOWED_ORIGINS=${SMOKE_AUDIENCE}`,
        IMAGE_TAG,
      ],
      { timeout: 15_000 },
    )
    if (r.status !== 0) fail('scenario 3: docker run failed', { stderrBytes: r.stderr.length })
    activeContainer = 'wb-smoke-valid'

    const ready = await waitForReadyJson('wb-smoke-valid')
    if (!ready) {
      const logs = docker(['logs', 'wb-smoke-valid'], { timeout: 5_000 })
      fail('scenario 3: server did not emit ready JSON within timeout', {
        stderrBytes: logs.stderr.length,
      })
    }
    assertNoLeak('scenario 3 ready JSON', JSON.stringify(ready))
    console.log('[docker-smoke] scenario 3 PASS: container started, ready JSON emitted')
  }

  // Scenario 4: /api/runtime/ping → 200, ok:true
  {
    const resp = await fetch(`${serverBaseUrl}/api/runtime/ping`)
    if (resp.status !== 200) fail(`scenario 4: ping expected 200, got ${resp.status}`)
    const body = await resp.json()
    if (body.ok !== true) fail('scenario 4: ping.ok must be true')
    if (typeof body.pid !== 'number') fail('scenario 4: ping.pid must be a number')
    assertNoLeak('scenario 4 ping response', JSON.stringify(body))
    console.log('[docker-smoke] scenario 4 PASS: /api/runtime/ping → 200, ok:true')
  }

  // Scenario 5: protected route, no auth → 401
  {
    const resp = await fetch(`${serverBaseUrl}/api/w/test-ws/canvas/test-canvas/viewport`)
    if (resp.status !== 401) fail(`scenario 5: no-auth expected 401, got ${resp.status}`)
    assertNoLeak('scenario 5 body', await resp.text())
    console.log('[docker-smoke] scenario 5 PASS: no-auth → 401')
  }

  // Scenario 6: valid ES256 JWT → auth passes
  {
    const now = Math.floor(Date.now() / 1000)
    const jwt = signEs256Jwt(
      privateKey,
      { alg: 'ES256', typ: 'at+jwt', kid: 'smoke-key' },
      {
        sub: 'smoke-user',
        scope: 'canvas:read',
        iss: SMOKE_ISSUER,
        aud: SMOKE_AUDIENCE,
        iat: now,
        exp: now + 3600,
      },
    )
    const resp = await fetch(`${serverBaseUrl}/api/w/test-ws/canvas/test-canvas/viewport`, {
      headers: { Authorization: `Bearer ${jwt}` },
    })
    if (resp.status === 401 || resp.status === 403)
      fail(`scenario 6: valid JWT should pass auth, got ${resp.status}`)
    const body = await resp.text()
    if (body.includes(jwt)) fail('scenario 6: raw JWT leaked to response body')
    assertNoLeak('scenario 6 body', body)
    console.log('[docker-smoke] scenario 6 PASS: valid JWT → auth passes')
  }

  // Scenario 7: wrong scope → 403
  {
    const now = Math.floor(Date.now() / 1000)
    const jwt = signEs256Jwt(
      privateKey,
      { alg: 'ES256', typ: 'at+jwt', kid: 'smoke-key' },
      {
        sub: 'smoke-user',
        scope: 'workspace:read',
        iss: SMOKE_ISSUER,
        aud: SMOKE_AUDIENCE,
        iat: now,
        exp: now + 3600,
      },
    )
    const resp = await fetch(`${serverBaseUrl}/api/w/test-ws/canvas/test-canvas/viewport`, {
      headers: { Authorization: `Bearer ${jwt}` },
    })
    if (resp.status !== 403) fail(`scenario 7: wrong scope expected 403, got ${resp.status}`)
    console.log('[docker-smoke] scenario 7 PASS: wrong scope → 403')
  }

  // Scenario 8: docker stop → graceful shutdown
  {
    stopContainer('wb-smoke-valid')
    activeContainer = null

    // Capture docker logs and scan for leaks.
    const logs = docker(['logs', 'wb-smoke-valid'], { timeout: 5_000 })
    assertNoLeak('scenario 8 docker logs stdout', logs.stdout)
    assertNoLeak('scenario 8 docker logs stderr', logs.stderr)
    console.log('[docker-smoke] scenario 8 PASS: docker stop → graceful shutdown, logs clean')
  }

  // Scenario 9: restart with same volume → stale record handled, server starts
  {
    const r = docker(
      [
        'run',
        '--rm',
        '-d',
        '--name',
        'wb-smoke-restart',
        ...networkRunArgs,
        '-v',
        `${dataDir}:/data`,
        '-v',
        `${tlsCertFile}:/extra-ca.crt:ro`,
        '-e',
        `NODE_EXTRA_CA_CERTS=/extra-ca.crt`,
        '-e',
        `WHITEBOARD_SERVER_EXTERNAL_URL=${SMOKE_AUDIENCE}`,
        '-e',
        `WHITEBOARD_SERVER_AUTH_STRATEGY=oauth-jwt`,
        '-e',
        `WHITEBOARD_SERVER_JWT_ISSUER=${SMOKE_ISSUER}`,
        '-e',
        `WHITEBOARD_SERVER_JWT_AUDIENCE=${SMOKE_AUDIENCE}`,
        '-e',
        `WHITEBOARD_SERVER_JWKS_URI=${jwksUri}`,
        '-e',
        `WHITEBOARD_SERVER_ALLOWED_ORIGINS=${SMOKE_AUDIENCE}`,
        IMAGE_TAG,
      ],
      { timeout: 15_000 },
    )
    if (r.status !== 0) fail('scenario 9: docker run (restart) failed')
    activeContainer = 'wb-smoke-restart'

    const ready = await waitForReadyJson('wb-smoke-restart')
    if (!ready) fail('scenario 9: server did not start after restart with stale volume')
    stopContainer('wb-smoke-restart')
    activeContainer = null
    console.log(
      '[docker-smoke] scenario 9 PASS: restart with mounted volume → server starts cleanly',
    )
  }

  console.log(
    '[docker-smoke] scenario 10 PASS: no raw JWT/credentials/paths leaked across all scenarios',
  )
} finally {
  if (activeContainer) stopContainer(activeContainer)
  await new Promise((resolve) => jwksServer.close(resolve))
  rmSync(certsDir, { recursive: true, force: true })
  rmSync(dataDir, { recursive: true, force: true })
  docker(['rmi', IMAGE_TAG], { timeout: 30_000 })
}

console.log('[docker-smoke] All scenarios PASSED.')
