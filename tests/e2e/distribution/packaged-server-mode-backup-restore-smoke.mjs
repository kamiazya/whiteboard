#!/usr/bin/env node

// Docker smoke for whiteboard server-mode backup / restore.
//
// End-to-end contract: seed data via live server A, backup the mounted
// data volume, restore into a fresh volume, boot server B on the restored
// volume, verify all seeded data survives the round-trip through the HTTP API.
//
//   1.  Docker available check → skip if not.
//   2.  Server image available (reused via WHITEBOARD_SMOKE_IMAGE, else built).
//   3.  Start container A with a fresh source data volume.
//   4.  Seed via valid JWT:
//         - workspace + canvas (Loro snapshot via canvas POST)
//         - file blob  (PUT /api/w/:ws/document/:path/file/:fileId)
//         - manual version + thumbnail
//         - workspace display name (PUT /api/workspaces/:ws/name)
//   5.  Capture snapshot bytes from server A for byte-equality check.
//   6.  Stop container A.
//   7.  backupServerModeDataDir → restoreServerModeDataDir via dist helper.
//   8.  Verify server-mode.json is absent from restored dir.
//   9.  Start container B with the restored data volume.
//  10.  Verify all seeded data via HTTP API (canvas list, snapshot bytes,
//       file bytes, version list + thumbnail bytes, workspace name).
//  11.  Verify 401 (no auth) and 403 (wrong scope) contracts still hold.
//  12.  Scan docker logs for JWT / credential / path leaks.
//  13.  Cleanup containers, JWKS server, temp dirs.
//
// Skip condition: `docker info` fails → Docker daemon not available.
// Requires: `pnpm --filter @kamiazya/whiteboard-mcp build`.
//
// This smoke is NOT part of pnpm test:e2e:distribution. Run explicitly:
//   node tests/e2e/distribution/packaged-server-mode-backup-restore-smoke.mjs

import { spawnSync } from 'node:child_process'
import { createSign, generateKeyPairSync } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpsServer } from 'node:https'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { assertNoLeak, resolveServerImage } from './smoke-helpers.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '../../..')

const IMAGE_TAG = 'whiteboard-server-smoke:test'
const SMOKE_ISSUER = 'https://auth.docker-br-smoke.example'
const SMOKE_AUDIENCE = 'https://whiteboard.docker-br-smoke.example'
// 4294/4295 are off the ports claimed by other distribution smokes and the
// main server-mode docker smoke (4293), so the full chain can run back-to-back.
const HOST_SERVER_PORT = 4294
const READINESS_TIMEOUT_MS = 60_000
const WORKSPACE_ID = 'sess-smoke-br'
const CANVAS_PATH = 'canvas-smoke-br'
const FILE_ID = 'filesmokebr001' // must match validateFileId: [A-Za-z0-9_-]{1,64}
const WORKSPACE_DISPLAY_NAME = 'Backup Restore Smoke'

const BACKUP_RESTORE_ENTRY = resolve(
  REPO_ROOT,
  'packages/mcp-server/dist/server/server-mode-backup-restore.js',
)

// Minimal valid PNG (1×1 white pixel) — satisfies the PNG signature check
// (bytes 0-3 = 89 50 4E 47) that the thumbnail and file-upload routes enforce.
const MINIMAL_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc, 0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82,
])

// ── Helpers ───────────────────────────────────────────────────────────────────

function fail(msg, ctx = {}) {
  console.error(`[docker-br-smoke] FAIL: ${msg}`)
  for (const [k, v] of Object.entries(ctx)) {
    if (v !== undefined && v !== '') {
      console.error(`  ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    }
  }
  process.exit(1)
}

function skip(reason) {
  console.log(`[docker-br-smoke] SKIP: ${reason}`)
  process.exit(0)
}

function docker(args, opts = {}) {
  return spawnSync('docker', args, { encoding: 'utf8', timeout: opts.timeout ?? 120_000, ...opts })
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
      'CN = docker-br-smoke-ca',
      '[san_ext]',
      'subjectAltName = IP:127.0.0.1,DNS:host.docker.internal',
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
    if (inspect.stdout.trim() !== 'true') {
      // Container stopped — capture logs now before they disappear.
      const exitLogs = docker(['logs', containerName], { timeout: 5_000 })
      return { _stopped: true, stdout: exitLogs.stdout, stderr: exitLogs.stderr }
    }
  }
  return null
}

function stopContainer(name) {
  docker(['stop', '-t', '10', name], { timeout: 20_000 })
}

// Poll the HTTP ping endpoint until it responds or the deadline passes.
// The container may emit the ready JSON before Docker's host-side port mapping
// is fully established, so the first HTTP request may arrive too early.
async function waitForHttpReady(baseUrl, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${baseUrl}/api/runtime/ping`)
      if (r.ok) return true
    } catch {
      /* port not yet reachable */
    }
    await delay(500)
  }
  return false
}

function makeJwt(privateKey, scope) {
  const now = Math.floor(Date.now() / 1000)
  return signEs256Jwt(
    privateKey,
    { alg: 'ES256', typ: 'at+jwt', kid: 'br-smoke-key' },
    {
      sub: 'br-smoke-user',
      scope,
      iss: SMOKE_ISSUER,
      aud: SMOKE_AUDIENCE,
      iat: now,
      exp: now + 3600,
    },
  )
}

async function authedFetch(baseUrl, path, jwt, init = {}) {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${jwt}`)
  return fetch(`${baseUrl}${path}`, { ...init, headers })
}

// ── Availability + dist check ─────────────────────────────────────────────────

if (docker(['info'], { timeout: 10_000 }).status !== 0) {
  skip('Docker daemon not available (docker info failed). Start Docker to run this smoke.')
}

if (!existsSync(BACKUP_RESTORE_ENTRY)) {
  console.error(`[docker-br-smoke] dist artifact missing: ${BACKUP_RESTORE_ENTRY}`)
  console.error('Run `pnpm --filter @kamiazya/whiteboard-mcp build` first.')
  process.exit(1)
}

console.log('[docker-br-smoke] Docker available. Starting backup/restore smoke.')

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
  label: 'docker-br-smoke',
})
console.log('[docker-br-smoke] scenario 1 PASS: image available')

// ── Shared credentials + JWKS mock ───────────────────────────────────────────

// On macOS with Colima (sshfs mount), only paths under $HOME are visible to Docker
// containers bidirectionally. System tmpdir (/var/folders, /tmp) is accessible from
// the container but writes do not propagate back to the macOS host. Using homedir()
// ensures the backup/restore host-side helpers can read data written by the server.
// On Linux, homedir() also works; system tmpdir would work too but consistency is better.
const TMP_BASE = homedir()
const certsDir = mkdtempSync(join(TMP_BASE, 'wb-docker-br-certs-'))
const srcDataDir = mkdtempSync(join(TMP_BASE, 'wb-docker-br-src-'))
// backupDir and restoredDataDir start as empty dirs — satisfies isEmptyDirOrMissing.
const backupDir = mkdtempSync(join(TMP_BASE, 'wb-docker-br-backup-'))
const restoredDataDir = mkdtempSync(join(TMP_BASE, 'wb-docker-br-restored-'))

// sshfs remaps all container UIDs to the macOS host user, so filesystem operations
// in the container succeed as long as the directory is world-writable on the host.
// Without this, the whiteboard container (UID 1001) cannot write to the directory.
chmodSync(srcDataDir, 0o777)
chmodSync(restoredDataDir, 0o777)

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const jwkPublic = publicKey.export({ format: 'jwk' })
const jwks = { keys: [{ ...jwkPublic, kid: 'br-smoke-key', use: 'sig', alg: 'ES256' }] }

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

// Dynamic path/URL literals that must not appear in server logs or response bodies.
const SMOKE_PATH_LITERALS = [srcDataDir, backupDir, restoredDataDir, certsDir, jwksUri]

// Broad scope JWT for seeding (covers all protected routes used in this smoke).
const SEED_SCOPES =
  'workspace:write workspace:read canvas:write canvas:read files:write files:read versions:write versions:read'

let activeContainer = null

try {
  // ── Scenario 2: source server A, seed data ────────────────────────────────

  {
    const args = [
      'run',
      '-d',
      '--name',
      'wb-br-smoke-src',
      ...networkRunArgs,
      '-v',
      `${srcDataDir}:/data`,
      '-v',
      `${tlsCertFile}:/extra-ca.crt:ro`,
      '-e',
      'NODE_EXTRA_CA_CERTS=/extra-ca.crt',
      '-e',
      `WHITEBOARD_SERVER_EXTERNAL_URL=${SMOKE_AUDIENCE}`,
      '-e',
      'WHITEBOARD_SERVER_AUTH_STRATEGY=oauth-jwt',
      '-e',
      `WHITEBOARD_SERVER_JWT_ISSUER=${SMOKE_ISSUER}`,
      '-e',
      `WHITEBOARD_SERVER_JWT_AUDIENCE=${SMOKE_AUDIENCE}`,
      '-e',
      `WHITEBOARD_SERVER_JWKS_URI=${jwksUri}`,
      '-e',
      `WHITEBOARD_SERVER_ALLOWED_ORIGINS=${SMOKE_AUDIENCE}`,
      SERVER_IMAGE,
    ]
    const r = docker(args, { timeout: 15_000 })
    if (r.status !== 0)
      fail('scenario 2: container A start failed', { stderrBytes: r.stderr?.length ?? 0 })
    activeContainer = 'wb-br-smoke-src'

    const ready = await waitForReadyJson('wb-br-smoke-src')
    if (!ready || ready._stopped) {
      fail('scenario 2: server A did not emit ready JSON', {
        stdoutBytes: (ready?.stdout ?? '').length,
        stderrBytes: (ready?.stderr ?? '').length,
      })
    }
    assertNoLeak('scenario 2 ready JSON', JSON.stringify(ready))
    if (!(await waitForHttpReady(serverBaseUrl))) {
      fail('scenario 2: HTTP ping did not respond after port mapping delay')
    }
    console.log('[docker-br-smoke] scenario 2 PASS: container A started')
  }

  // ── Scenario 3: seed via valid JWT ────────────────────────────────────────

  let seededSnapshotBytes
  let seededVersionId
  {
    const jwt = makeJwt(privateKey, SEED_SCOPES)

    // Create workspace + canvas (workspace:write).
    const createRes = await authedFetch(
      serverBaseUrl,
      `/api/workspaces/${encodeURIComponent(WORKSPACE_ID)}/documents`,
      jwt,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: CANVAS_PATH }),
      },
    )
    if (!createRes.ok) {
      const t = await createRes.text().catch(() => '')
      fail('scenario 3: canvas create failed', { status: createRes.status, bodyLength: t.length })
    }

    // Verify canvas list (workspace:read).
    const listRes = await authedFetch(
      serverBaseUrl,
      `/api/workspaces/${encodeURIComponent(WORKSPACE_ID)}/documents`,
      jwt,
    )
    if (!listRes.ok) fail(`scenario 3: canvas list failed with ${listRes.status}`)
    const list = await listRes.json()
    if (!(list?.documents ?? []).some((c) => c.path === CANVAS_PATH)) {
      fail('scenario 3: seeded canvas not in list', {
        documentCount: (list?.documents ?? []).length,
      })
    }

    // Capture Loro snapshot bytes (canvas:read).
    const snapshotRes = await authedFetch(
      serverBaseUrl,
      `/api/w/${encodeURIComponent(WORKSPACE_ID)}/document/${encodeURIComponent(CANVAS_PATH)}/snapshot`,
      jwt,
    )
    if (!snapshotRes.ok) fail(`scenario 3: snapshot fetch failed with ${snapshotRes.status}`)
    seededSnapshotBytes = new Uint8Array(await snapshotRes.arrayBuffer())
    if (seededSnapshotBytes.byteLength === 0) fail('scenario 3: snapshot bytes empty')

    // Upload file blob (files:write).
    const uploadRes = await authedFetch(
      serverBaseUrl,
      `/api/w/${encodeURIComponent(WORKSPACE_ID)}/document/${encodeURIComponent(CANVAS_PATH)}/file/${FILE_ID}`,
      jwt,
      { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: MINIMAL_PNG },
    )
    if (uploadRes.status !== 204) fail(`scenario 3: file upload failed with ${uploadRes.status}`)

    // Save manual version (versions:write).
    const versionRes = await authedFetch(
      serverBaseUrl,
      `/api/workspaces/${encodeURIComponent(WORKSPACE_ID)}/documents/${encodeURIComponent(CANVAS_PATH)}/versions`,
      jwt,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'smoke-seed-version' }),
      },
    )
    if (!versionRes.ok) fail(`scenario 3: version save failed with ${versionRes.status}`)
    const versionBody = await versionRes.json()
    seededVersionId = versionBody?.version?.id
    if (!seededVersionId)
      fail('scenario 3: version save returned no id', {
        bodyLength: JSON.stringify(versionBody).length,
      })

    // Save version thumbnail (versions:write).
    const thumbRes = await authedFetch(
      serverBaseUrl,
      `/api/workspaces/${encodeURIComponent(WORKSPACE_ID)}/documents/${encodeURIComponent(CANVAS_PATH)}/versions/${seededVersionId}/thumbnail`,
      jwt,
      { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: MINIMAL_PNG },
    )
    if (!thumbRes.ok) fail(`scenario 3: thumbnail upload failed with ${thumbRes.status}`)

    // The workspace's own display name — a workspaces-table row rather than
    // anything inside a document, which is a category of state the backup has
    // to carry and no other step here touches.
    const nameRes = await authedFetch(
      serverBaseUrl,
      `/api/workspaces/${encodeURIComponent(WORKSPACE_ID)}/name`,
      jwt,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: WORKSPACE_DISPLAY_NAME }),
      },
    )
    if (!nameRes.ok) fail(`scenario 3: workspace name save failed with ${nameRes.status}`)

    console.log(
      `[docker-br-smoke] scenario 3 PASS: seeded workspace=${WORKSPACE_ID}, canvas=${CANVAS_PATH}, snapshot=${seededSnapshotBytes.byteLength} bytes, versionId=${seededVersionId}`,
    )
  }

  // ── Scenario 4: stop server A ─────────────────────────────────────────────

  {
    stopContainer('wb-br-smoke-src')
    activeContainer = null
    const logs = docker(['logs', 'wb-br-smoke-src'], { timeout: 5_000 })
    assertNoLeak('scenario 4 server A logs stdout', logs.stdout, SMOKE_PATH_LITERALS)
    assertNoLeak('scenario 4 server A logs stderr', logs.stderr, SMOKE_PATH_LITERALS)
    console.log('[docker-br-smoke] scenario 4 PASS: server A stopped, logs clean')
  }

  // ── Scenario 5: backup + restore ─────────────────────────────────────────

  {
    const { backupServerModeDataDir, restoreServerModeDataDir } = await import(
      `file://${BACKUP_RESTORE_ENTRY}`
    )

    await backupServerModeDataDir(srcDataDir, backupDir, { allowedRoots: [srcDataDir, backupDir] })
    await restoreServerModeDataDir(backupDir, restoredDataDir, {
      allowedRoots: [backupDir, restoredDataDir],
    })

    // Stale server-mode.json must have been removed from restored dir.
    const recordPath = join(restoredDataDir, 'server-mode.json')
    if (existsSync(recordPath)) {
      fail('scenario 5: server-mode.json was not neutralized in restored dir — stale identity risk')
    }

    console.log(
      '[docker-br-smoke] scenario 5 PASS: backup → restore ok, server-mode.json neutralized',
    )
  }

  // ── Scenario 6: start server B on restored volume ────────────────────────

  {
    const args = [
      'run',
      '-d',
      '--name',
      'wb-br-smoke-restored',
      ...networkRunArgs,
      '-v',
      `${restoredDataDir}:/data`,
      '-v',
      `${tlsCertFile}:/extra-ca.crt:ro`,
      '-e',
      'NODE_EXTRA_CA_CERTS=/extra-ca.crt',
      '-e',
      `WHITEBOARD_SERVER_EXTERNAL_URL=${SMOKE_AUDIENCE}`,
      '-e',
      'WHITEBOARD_SERVER_AUTH_STRATEGY=oauth-jwt',
      '-e',
      `WHITEBOARD_SERVER_JWT_ISSUER=${SMOKE_ISSUER}`,
      '-e',
      `WHITEBOARD_SERVER_JWT_AUDIENCE=${SMOKE_AUDIENCE}`,
      '-e',
      `WHITEBOARD_SERVER_JWKS_URI=${jwksUri}`,
      '-e',
      `WHITEBOARD_SERVER_ALLOWED_ORIGINS=${SMOKE_AUDIENCE}`,
      SERVER_IMAGE,
    ]
    const r = docker(args, { timeout: 15_000 })
    if (r.status !== 0)
      fail('scenario 6: container B start failed', { stderrBytes: r.stderr?.length ?? 0 })
    activeContainer = 'wb-br-smoke-restored'

    const ready = await waitForReadyJson('wb-br-smoke-restored')
    if (!ready || ready._stopped) {
      fail('scenario 6: server B did not emit ready JSON — stale record may have blocked startup', {
        stdoutBytes: (ready?.stdout ?? '').length,
        stderrBytes: (ready?.stderr ?? '').length,
      })
    }
    assertNoLeak('scenario 6 ready JSON', JSON.stringify(ready))
    if (!(await waitForHttpReady(serverBaseUrl))) {
      fail('scenario 6: HTTP ping did not respond after port mapping delay')
    }
    console.log('[docker-br-smoke] scenario 6 PASS: server B started on restored volume')
  }

  // ── Scenario 7: verify seeded data survived restore ───────────────────────

  {
    const jwt = makeJwt(privateKey, SEED_SCOPES)

    // Canvas list (workspace:read).
    const listRes = await authedFetch(
      serverBaseUrl,
      `/api/workspaces/${encodeURIComponent(WORKSPACE_ID)}/documents`,
      jwt,
    )
    if (!listRes.ok)
      fail(`scenario 7: canvas list on restored server failed with ${listRes.status}`)
    const list = await listRes.json()
    if (!(list?.documents ?? []).some((c) => c.path === CANVAS_PATH)) {
      fail('scenario 7: seeded canvas missing from restored server', {
        documentCount: (list?.documents ?? []).length,
      })
    }

    // Snapshot byte-equality (canvas:read).
    const snapshotRes = await authedFetch(
      serverBaseUrl,
      `/api/w/${encodeURIComponent(WORKSPACE_ID)}/document/${encodeURIComponent(CANVAS_PATH)}/snapshot`,
      jwt,
    )
    if (!snapshotRes.ok)
      fail(`scenario 7: snapshot fetch on restored server failed with ${snapshotRes.status}`)
    const restoredSnapshot = new Uint8Array(await snapshotRes.arrayBuffer())
    if (restoredSnapshot.byteLength === 0) fail('scenario 7: restored snapshot is empty')
    if (restoredSnapshot.byteLength !== seededSnapshotBytes.byteLength) {
      fail('scenario 7: snapshot byte length mismatch', {
        seeded: seededSnapshotBytes.byteLength,
        restored: restoredSnapshot.byteLength,
      })
    }
    for (let i = 0; i < seededSnapshotBytes.byteLength; i++) {
      if (restoredSnapshot[i] !== seededSnapshotBytes[i]) {
        fail(`scenario 7: snapshot byte mismatch at index ${i}`)
      }
    }

    // File blob (files:read).
    const fileRes = await authedFetch(
      serverBaseUrl,
      `/api/w/${encodeURIComponent(WORKSPACE_ID)}/document/${encodeURIComponent(CANVAS_PATH)}/file/${FILE_ID}`,
      jwt,
    )
    if (!fileRes.ok) fail(`scenario 7: file GET on restored server failed with ${fileRes.status}`)
    const restoredFileBytes = new Uint8Array(await fileRes.arrayBuffer())
    if (restoredFileBytes.byteLength !== MINIMAL_PNG.byteLength) {
      fail('scenario 7: restored file byte length mismatch', {
        expected: MINIMAL_PNG.byteLength,
        got: restoredFileBytes.byteLength,
      })
    }

    // Version list (versions:read).
    const versionsRes = await authedFetch(
      serverBaseUrl,
      `/api/workspaces/${encodeURIComponent(WORKSPACE_ID)}/documents/${encodeURIComponent(CANVAS_PATH)}/versions`,
      jwt,
    )
    if (!versionsRes.ok)
      fail(`scenario 7: version list on restored server failed with ${versionsRes.status}`)
    const versions = await versionsRes.json()
    const foundVersion = (versions?.versions ?? []).find((v) => v.id === seededVersionId)
    if (!foundVersion) {
      fail('scenario 7: seeded version missing from restored server', {
        versionCount: (versions?.versions ?? []).length,
      })
    }
    if (foundVersion.label !== 'smoke-seed-version') {
      fail('scenario 7: restored version label mismatch', {
        labelLength: foundVersion.label?.length ?? 0,
      })
    }

    // Version thumbnail (versions:read).
    const thumbRes = await authedFetch(
      serverBaseUrl,
      `/api/workspaces/${encodeURIComponent(WORKSPACE_ID)}/documents/${encodeURIComponent(CANVAS_PATH)}/versions/${seededVersionId}/thumbnail`,
      jwt,
    )
    if (!thumbRes.ok)
      fail(`scenario 7: thumbnail GET on restored server failed with ${thumbRes.status}`)
    const restoredThumb = new Uint8Array(await thumbRes.arrayBuffer())
    if (restoredThumb.byteLength !== MINIMAL_PNG.byteLength) {
      fail('scenario 7: restored thumbnail byte length mismatch')
    }

    // Workspace display name.
    const namesRes = await authedFetch(
      serverBaseUrl,
      `/api/workspaces/${encodeURIComponent(WORKSPACE_ID)}/names`,
      jwt,
    )
    if (!namesRes.ok)
      fail(`scenario 7: names GET on restored server failed with ${namesRes.status}`)
    const names = await namesRes.json()
    if (names?.workspace !== WORKSPACE_DISPLAY_NAME) {
      fail('scenario 7: workspace display name missing from restored server', {
        got: names?.workspace,
        want: WORKSPACE_DISPLAY_NAME,
      })
    }

    console.log('[docker-br-smoke] scenario 7 PASS: all seeded data verified on restored server')
  }

  // ── Scenario 8: auth contract still enforced on restored server ───────────

  {
    const _jwt = makeJwt(privateKey, SEED_SCOPES)

    // No auth → 401.
    const noAuthRes = await fetch(
      `${serverBaseUrl}/api/workspaces/${encodeURIComponent(WORKSPACE_ID)}/documents`,
    )
    if (noAuthRes.status !== 401) fail(`scenario 8: no-auth expected 401, got ${noAuthRes.status}`)
    assertNoLeak('scenario 8 no-auth body', await noAuthRes.text(), SMOKE_PATH_LITERALS)

    // Wrong scope → 403.
    const wrongJwt = makeJwt(privateKey, 'workspace:read')
    const wrongScopeRes = await authedFetch(
      serverBaseUrl,
      `/api/workspaces/${encodeURIComponent(WORKSPACE_ID)}/documents`,
      wrongJwt,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'should-fail' }),
      },
    )
    if (wrongScopeRes.status !== 403) {
      fail(`scenario 8: wrong scope expected 403, got ${wrongScopeRes.status}`)
    }

    console.log(
      '[docker-br-smoke] scenario 8 PASS: 401/403 auth contracts enforced on restored server',
    )
  }

  // ── Scenario 9: docker logs non-leak scan ─────────────────────────────────

  {
    stopContainer('wb-br-smoke-restored')
    activeContainer = null
    const logs = docker(['logs', 'wb-br-smoke-restored'], { timeout: 5_000 })
    assertNoLeak('scenario 9 server B logs stdout', logs.stdout, SMOKE_PATH_LITERALS)
    assertNoLeak('scenario 9 server B logs stderr', logs.stderr, SMOKE_PATH_LITERALS)
    console.log('[docker-br-smoke] scenario 9 PASS: server B logs clean, no leaks')
  }

  console.log('[docker-br-smoke] All scenarios PASSED.')
} finally {
  if (activeContainer) stopContainer(activeContainer)
  // Remove containers explicitly (no --rm used, so they persist after stop/crash).
  docker(['rm', '-f', 'wb-br-smoke-src'], { timeout: 10_000 })
  docker(['rm', '-f', 'wb-br-smoke-restored'], { timeout: 10_000 })
  await new Promise((res) => jwksServer.close(res))
  rmSync(certsDir, { recursive: true, force: true })
  rmSync(srcDataDir, { recursive: true, force: true })
  rmSync(backupDir, { recursive: true, force: true })
  rmSync(restoredDataDir, { recursive: true, force: true })
  // Only tear down an image this run built. A reused one belongs to the
  // caller that built it, and the next smoke in the same job needs it.
  if (SERVER_IMAGE === IMAGE_TAG) docker(['rmi', IMAGE_TAG], { timeout: 30_000 })
}
