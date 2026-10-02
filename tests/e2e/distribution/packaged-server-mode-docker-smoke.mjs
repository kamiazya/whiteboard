#!/usr/bin/env node

// Docker smoke for whiteboard server-mode.
//
// Verifies the Dockerfile.server artifact at the container boundary:
//   1.  Server image available (reused via WHITEBOARD_SMOKE_IMAGE, else built).
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

import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer as createHttpsServer } from 'node:https'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertNoLeak,
  createFail,
  createSkip,
  docker,
  generateTestTlsCert,
  redactForDiagnostics,
  resolveServerImage,
  signEs256Jwt,
  stopContainer,
  waitForContainerReadyJson,
} from './smoke-helpers.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '../../..')

const IMAGE_TAG = 'whiteboard-server-smoke:test'
const SMOKE_ISSUER = 'https://auth.docker-smoke.example'
const SMOKE_AUDIENCE = 'https://whiteboard.docker-smoke.example'
const HOST_SERVER_PORT = 4293 // host port mapped to container's 3099

// ── Helpers ──────────────────────────────────────────────────────────────────

const fail = createFail('docker-smoke')
const skip = createSkip('docker-smoke')

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

const SERVER_IMAGE = resolveServerImage({
  repoRoot: REPO_ROOT,
  defaultTag: IMAGE_TAG,
  docker,
  fail,
  label: 'docker-smoke',
})
console.log('[docker-smoke] scenario 1 PASS: image available')

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
      SERVER_IMAGE,
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

const { certFile: tlsCertFile, keyFile: tlsKeyFile } = generateTestTlsCert(certsDir, {
  commonName: 'docker-smoke-ca',
})
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
        // No `--rm` on this one, deliberately. The server is EXPECTED to stay
        // up here, so the interesting failure is it exiting immediately — and
        // `--rm` deletes the container the instant it does, leaving
        // `docker logs` to answer `No such container` and the smoke to report
        // a readiness timeout for a container that never lived. Measured on
        // CI: scenario 3 "timed out" 1.4s after scenario 2, with a 60s budget.
        // The finally block removes it explicitly instead.
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
        SERVER_IMAGE,
      ],
      { timeout: 15_000 },
    )
    if (r.status !== 0) fail('scenario 3: docker run failed', { stderrBytes: r.stderr.length })
    activeContainer = 'wb-smoke-valid'

    const ready = await waitForContainerReadyJson('wb-smoke-valid')
    if (!ready) {
      const logs = docker(['logs', 'wb-smoke-valid'], { timeout: 5_000 })
      const exit = docker(['inspect', '--format={{.State.ExitCode}}', 'wb-smoke-valid'], {
        timeout: 5_000,
      })
      fail('scenario 3: server never became ready', {
        exitCode: exit.stdout.trim() || 'unknown',
        // Redacted rather than counted: this smoke runs on CI now, where a
        // byte count is the only thing anyone gets and it diagnoses nothing.
        stdout: redactForDiagnostics(logs.stdout.slice(-2000), [dataDir, certsDir, jwksUri]),
        stderr: redactForDiagnostics(logs.stderr.slice(-2000), [dataDir, certsDir, jwksUri]),
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
    // The contract is daemonPingResponseSchema (daemon-client/api-contracts/
    // runtime.ts): { ok: true, instanceId: string, identity?: {alg, publicKey} }.
    // This asserted `typeof body.pid === 'number'` — a field the response has
    // not carried since instanceId replaced it, and the route parses through
    // the schema, so a raw pid could not reach the wire even if the handler
    // built one. Nothing caught the drift because this smoke ran only on the
    // release path. The startup line on stdout is a DIFFERENT payload and does
    // still carry pid; that is what waitForContainerReadyJson reads.
    if (body.ok !== true) fail('scenario 4: ping.ok must be true')
    if (typeof body.instanceId !== 'string' || body.instanceId.length === 0) {
      fail('scenario 4: ping.instanceId must be a non-empty string')
    }
    if (body.identity !== undefined) {
      if (typeof body.identity.alg !== 'string' || typeof body.identity.publicKey !== 'string') {
        fail('scenario 4: ping.identity must carry alg and publicKey')
      }
    }
    assertNoLeak('scenario 4 ping response', JSON.stringify(body))
    console.log('[docker-smoke] scenario 4 PASS: /api/runtime/ping → 200, ok:true')
  }

  // Scenario 5: protected route, no auth → 401
  {
    const resp = await fetch(`${serverBaseUrl}/api/w/test-ws/document/test-canvas/viewport`)
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
    const resp = await fetch(`${serverBaseUrl}/api/w/test-ws/document/test-canvas/viewport`, {
      headers: { Authorization: `Bearer ${jwt}` },
    })
    // Authentication passes; the workspace then answers by membership. It has
    // none (ADR-0046 decision 10: members-only from the start), so the
    // expected answer is the membership refusal, not an auth one.
    if (resp.status !== 403) fail(`scenario 6: expected a membership 403, got ${resp.status}`)
    const body = await resp.text()
    if (!body.includes('not_a_member')) fail('scenario 6: 403 was not the membership refusal')
    if (body.includes(jwt)) fail('scenario 6: raw JWT leaked to response body')
    assertNoLeak('scenario 6 body', body)
    console.log(
      '[docker-smoke] scenario 6 PASS: valid JWT authenticates; workspace refuses a non-member',
    )
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
    const resp = await fetch(`${serverBaseUrl}/api/w/test-ws/document/test-canvas/viewport`, {
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
    // The subject has to be PRESENT for the scan below to mean anything, and
    // it was not: with `--rm` (removed above) `docker stop` deletes the
    // container, so this read answered `No such container` and both
    // assertions scanned an empty string. A leak check that cannot fail is
    // the failure.
    if (logs.stdout.length === 0) {
      fail('scenario 8: no container logs to scan — the leak check would be vacuous')
    }
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
        SERVER_IMAGE,
      ],
      { timeout: 15_000 },
    )
    if (r.status !== 0) fail('scenario 9: docker run (restart) failed')
    activeContainer = 'wb-smoke-restart'

    const ready = await waitForContainerReadyJson('wb-smoke-restart')
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
  if (activeContainer) {
    stopContainer(activeContainer)
    // Explicit, because scenario 3's container is started without `--rm` so a
    // crash leaves its logs readable.
    docker(['rm', '-f', activeContainer], { timeout: 20_000 })
  }
  await new Promise((resolve) => jwksServer.close(resolve))
  rmSync(certsDir, { recursive: true, force: true })
  rmSync(dataDir, { recursive: true, force: true })
  // Only tear down an image this run built. A reused one belongs to the
  // caller that built it, and the next smoke in the same job needs it.
  if (SERVER_IMAGE === IMAGE_TAG) docker(['rmi', IMAGE_TAG], { timeout: 30_000 })
}

console.log('[docker-smoke] All scenarios PASSED.')
