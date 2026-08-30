#!/usr/bin/env node

// Distribution smoke for `whiteboard server backup` and `whiteboard server restore` CLI.
//
// End-to-end contract: seed data via a local daemon, backup via CLI, restore via
// CLI, boot a server-mode instance on the restored dir, verify the seeded data
// is reachable through the protected HTTP API.
//
//   1.  Build artifact check.
//   2.  Seed data via daemon (port 4292).
//   3.  Backup via `whiteboard server backup --json`.
//   4.  Restore via `whiteboard server restore --json`.
//   5.  Boot server-mode (port 4295) on restored dir, verify seeded canvas.
//   6.  Non-empty output dir rejection.
//   7.  Non-empty target dir rejection.
//   8.  Symlink inside data dir rejection (backup).
//   9.  CLI path ancestor symlink rejection (backup --output-dir through symlink).
//  10.  CLI path ancestor symlink rejection (restore --target-dir through symlink).
//  11.  Running-record rejection (backup).
//  12.  Running-record rejection (restore).
//  13.  Usage regression (--json missing, required flags missing, unknown flag redacted).
//  14.  Dispatcher routing (backup/restore subcommands, unknown subcommand unchanged).
//  15.  Server support-bundle: missing record → success, deterministic files, safe sections.
//  16.  Server support-bundle: non-empty output dir → exit 1.
//  17.  Server support-bundle: symlink final output dir → exit 1.
//  18.  Server support-bundle: ancestor symlink in output path → exit 1.
//  19.  Server support-bundle: usage regression.
//  20.  Stdout / stderr non-leak scan (all collected output).
//  21.  Server support-bundle: running server → identity-confirmed status/record.
//
// Ports: 4292 (seed daemon), 4295 (restored server-mode), 4296 (bundle live server).
// Run: node tests/e2e/distribution/packaged-server-mode-cli-smoke.mjs

import { spawn, spawnSync } from 'node:child_process'
import { createSign, generateKeyPairSync } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer as createHttpsServer } from 'node:https'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { assertNoLeak, scrubDevEnv } from './smoke-helpers.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '../../..')
const DIST_CLI = resolve(REPO_ROOT, 'packages/mcp-server/dist/cli/index.js')

const DAEMON_PORT = 4292
const SERVER_PORT = 4295
const SEED_TOKEN = 'smoke-cli-seed-token-x7z9q'
const SMOKE_ISSUER = 'https://auth.server-cli-smoke.example'
const SMOKE_AUDIENCE = 'https://whiteboard.server-cli-smoke.example'
const WORKSPACE_ID = 'sess-cli-smoke'
const CANVAS_PATH = 'canvas-cli-smoke'

// ── Helpers ───────────────────────────────────────────────────────────────────

const leakTexts = [] // accumulated for the final non-leak pass

function fail(msg, ctx = {}) {
  console.error(`[server-cli-smoke] FAIL: ${msg}`)
  for (const [k, v] of Object.entries(ctx)) {
    if (v !== undefined && v !== '') {
      console.error(`  ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    }
  }
  process.exit(1)
}

// assertNoLeak (BASE_LEAK_PATTERNS) is imported from smoke-helpers.mjs.

function cli(args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [DIST_CLI, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...scrubDevEnv(process.env), ...extraEnv },
  })
  leakTexts.push({
    label: `cli ${args.slice(0, 3).join(' ')}`,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  })
  return r
}

async function waitForReadyJson(proc, timeoutMs = 30_000) {
  return new Promise((res) => {
    let buf = ''
    const timer = setTimeout(() => res(null), timeoutMs)
    proc.stdout.on('data', (chunk) => {
      buf += chunk.toString()
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const obj = JSON.parse(line)
          if (obj.ok === true && typeof obj.pid === 'number') {
            clearTimeout(timer)
            res(obj)
            return
          }
        } catch {
          /* not JSON */
        }
      }
    })
    proc.on('exit', () => {
      clearTimeout(timer)
      res(null)
    })
  })
}

async function waitForHttpReady(url, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url)
      if (r.ok) return true
    } catch {
      /* not yet */
    }
    await delay(300)
  }
  return false
}

function killProc(proc) {
  try {
    proc.kill('SIGTERM')
  } catch {
    /* already gone */
  }
}

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
      'CN = server-cli-smoke-ca',
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

function base64url(data) {
  return Buffer.from(data).toString('base64url')
}
function derToRawEs256(der) {
  let off = 2
  const rLen = der[off + 1]
  let r = der.slice(off + 2, off + 2 + rLen)
  if (r[0] === 0x00) r = r.slice(1)
  off += 2 + rLen
  const sLen = der[off + 1]
  let s = der.slice(off + 2, off + 2 + sLen)
  if (s[0] === 0x00) s = s.slice(1)
  const rp = Buffer.alloc(32)
  r.copy(rp, 32 - r.length)
  const sp = Buffer.alloc(32)
  s.copy(sp, 32 - s.length)
  return Buffer.concat([rp, sp])
}
function signEs256Jwt(priv, header, payload) {
  const h = base64url(JSON.stringify(header))
  const p = base64url(JSON.stringify(payload))
  const signer = createSign('SHA256')
  signer.update(`${h}.${p}`)
  const raw = derToRawEs256(signer.sign({ key: priv, dsaEncoding: 'der' }))
  return `${h}.${p}.${base64url(raw)}`
}
function makeJwt(priv, scope) {
  const now = Math.floor(Date.now() / 1000)
  return signEs256Jwt(
    priv,
    { alg: 'ES256', typ: 'at+jwt', kid: 'cli-smoke-key' },
    {
      sub: 'cli-smoke-user',
      scope,
      iss: SMOKE_ISSUER,
      aud: SMOKE_AUDIENCE,
      iat: now,
      exp: now + 3600,
    },
  )
}

// ── Scenario 1: build artifact check ─────────────────────────────────────────

if (!existsSync(DIST_CLI)) {
  console.error(`[server-cli-smoke] dist artifact missing: ${DIST_CLI}`)
  console.error('Run `pnpm --filter @kamiazya/whiteboard-mcp build` first.')
  process.exit(1)
}

console.log('[server-cli-smoke] Starting server backup/restore CLI smoke.')

// ── Shared temp dirs ──────────────────────────────────────────────────────────

// Canonicalize so paths don't traverse system-level symlinks (e.g. /var →
// /private/var on macOS) that would trip the ancestor-symlink guard in the CLI.
const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), 'wb-cli-smoke-')))
const certsDir = join(tmpRoot, 'certs')
const srcDataDir = join(tmpRoot, 'src-data')
const backupDir = join(tmpRoot, 'backup')
const restoredDir = join(tmpRoot, 'restored')
mkdirSync(certsDir)
mkdirSync(srcDataDir)

const SMOKE_LITERALS = [srcDataDir, backupDir, restoredDir, certsDir, SEED_TOKEN]

// ── JWKS mock setup (used for scenarios 2 and 5) ─────────────────────────────

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const jwkPublic = publicKey.export({ format: 'jwk' })
const jwks = { keys: [{ ...jwkPublic, kid: 'cli-smoke-key', use: 'sig', alg: 'ES256' }] }
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
  srv.listen(0, '127.0.0.1', () => resolve(srv))
  srv.once('error', reject)
})
const jwksPort = jwksServer.address().port
const jwksUri = `https://127.0.0.1:${jwksPort}/.well-known/jwks.json`
SMOKE_LITERALS.push(jwksUri)

let seedDaemon = null
let serverMode = null
let bundleServer2 = null

try {
  // ── Scenario 2: seed data via daemon ───────────────────────────────────────

  {
    seedDaemon = spawn(
      process.execPath,
      [
        DIST_CLI,
        'daemon',
        'run',
        '--json',
        '--host=127.0.0.1',
        `--port=${DAEMON_PORT}`,
        `--data-dir=${srcDataDir}`,
      ],
      { stdio: 'pipe', env: { ...scrubDevEnv(process.env), WHITEBOARD_DAEMON_TOKEN: SEED_TOKEN } },
    )

    const ready = await waitForReadyJson(seedDaemon)
    if (!ready) fail('scenario 2: daemon did not emit ready JSON')
    if (!(await waitForHttpReady(`http://127.0.0.1:${DAEMON_PORT}/api/runtime/ping`))) {
      fail('scenario 2: daemon HTTP not ready')
    }

    // Seed workspace + canvas.
    const createRes = await fetch(
      `http://127.0.0.1:${DAEMON_PORT}/api/workspaces/${WORKSPACE_ID}/documents`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SEED_TOKEN}` },
        body: JSON.stringify({ path: CANVAS_PATH }),
      },
    )
    if (!createRes.ok) fail('scenario 2: canvas create failed', { status: createRes.status })

    killProc(seedDaemon)
    // Give the daemon time to flush and write its record.
    await delay(500)
    seedDaemon = null
    console.log('[server-cli-smoke] scenario 2 PASS: seeded canvas via daemon')
  }

  // ── Scenario 3: backup via CLI ─────────────────────────────────────────────

  {
    const r = cli([
      'server',
      'backup',
      '--json',
      `--data-dir=${srcDataDir}`,
      `--output-dir=${backupDir}`,
    ])
    if (r.status !== 0) {
      fail('scenario 3: backup CLI failed', { stderrBytes: (r.stderr ?? '').length })
    }
    let backupJson
    try {
      backupJson = JSON.parse(r.stdout.trim())
    } catch {
      fail('scenario 3: backup stdout is not valid JSON')
    }
    if (backupJson.schemaVersion !== 2) fail('scenario 3: schemaVersion mismatch')
    if (backupJson.ok !== true) fail('scenario 3: ok not true')
    if (backupJson.operation !== 'backup') fail('scenario 3: operation mismatch')
    // `ok` no longer answers "is my backup complete?" — that is per store now,
    // so the smoke has to read the part that carries the meaning. This
    // deployment keeps its rows in the data directory, so both are captured.
    if (backupJson.stores?.database?.captured !== true) {
      fail('scenario 3: stores.database not reported captured')
    }
    if (backupJson.stores?.blobs?.captured !== true) {
      fail('scenario 3: stores.blobs not reported captured')
    }
    assertNoLeak('scenario 3 backup stdout', r.stdout, SMOKE_LITERALS)
    assertNoLeak('scenario 3 backup stderr', r.stderr ?? '')

    // The daemon record holds the Bearer token and is written owner-only. It
    // must never reach a backup — a directory that gets copied to another
    // disk, shipped to support, kept for months. This is reachable here
    // because the seed daemon above was killed rather than stopped
    // gracefully, so its record is still on disk for the backup to skip.
    const backedUp = readdirSync(backupDir)
    if (backedUp.includes('daemon.json')) {
      fail('scenario 3: backup carries the daemon record (Bearer token)')
    }
    if (backedUp.includes('backup-in-progress.json')) {
      fail("scenario 3: backup carries the backup command's own marker")
    }
    for (const name of backedUp) {
      const full = join(backupDir, name)
      if (!existsSync(full) || statSync(full).isDirectory()) continue
      assertNoLeak(`scenario 3 backup file ${name}`, readFileSync(full, 'utf8'), SMOKE_LITERALS)
    }
    // The blob manifest is part of the published artifact now (ADR-0021
    // decision 5): it is what restore reads to know which blobs to
    // materialise, and what retention reads to know what a backup still
    // needs. A backup without it restores nothing from the mirror.
    if (!backedUp.includes('blobs.json')) {
      fail('scenario 3: backup carries no blob manifest')
    }
    let manifest
    try {
      manifest = JSON.parse(readFileSync(join(backupDir, 'blobs.json'), 'utf8'))
    } catch {
      fail('scenario 3: blob manifest is not valid JSON')
    }
    if (manifest.schemaVersion !== 2) fail('scenario 3: blob manifest schemaVersion mismatch')
    // No `--mirror-dir`, so this backup keeps its own mirror and stays a
    // directory an operator can carry away.
    if (manifest.mirror !== 'self') fail('scenario 3: a one-off backup is not self-contained')
    console.log('[server-cli-smoke] scenario 3 PASS: backup CLI succeeded, no credential copied')
  }

  // ── Scenario 4: restore via CLI ────────────────────────────────────────────

  {
    const r = cli([
      'server',
      'restore',
      '--json',
      `--backup-dir=${backupDir}`,
      `--target-dir=${restoredDir}`,
    ])
    if (r.status !== 0) {
      fail('scenario 4: restore CLI failed', { stderrBytes: (r.stderr ?? '').length })
    }
    let restoreJson
    try {
      restoreJson = JSON.parse(r.stdout.trim())
    } catch {
      fail('scenario 4: restore stdout is not valid JSON')
    }
    if (restoreJson.schemaVersion !== 1) fail('scenario 4: schemaVersion mismatch')
    if (restoreJson.ok !== true) fail('scenario 4: ok not true')
    if (restoreJson.operation !== 'restore') fail('scenario 4: operation mismatch')

    // server-mode.json must have been removed from restored dir.
    if (existsSync(join(restoredDir, 'server-mode.json'))) {
      fail('scenario 4: server-mode.json was not removed from restored dir')
    }
    assertNoLeak('scenario 4 restore stdout', r.stdout, SMOKE_LITERALS)
    assertNoLeak('scenario 4 restore stderr', r.stderr ?? '')
    console.log(
      '[server-cli-smoke] scenario 4 PASS: restore CLI succeeded, server-mode.json neutralized',
    )
  }

  // ── Scenario 5: restored server-mode can boot and serve seeded canvas ──────

  {
    serverMode = spawn(
      process.execPath,
      [
        DIST_CLI,
        'server',
        'run',
        '--json',
        `--data-dir=${restoredDir}`,
        `--external-url=${SMOKE_AUDIENCE}`,
        '--auth-strategy=oauth-jwt',
        `--jwt-issuer=${SMOKE_ISSUER}`,
        `--jwt-audience=${SMOKE_AUDIENCE}`,
        `--jwks-uri=${jwksUri}`,
        `--allowed-origins=${SMOKE_AUDIENCE}`,
      ],
      {
        stdio: 'pipe',
        env: {
          ...scrubDevEnv(process.env),
          WHITEBOARD_SERVER_PORT: String(SERVER_PORT),
          NODE_EXTRA_CA_CERTS: tlsCertFile,
        },
      },
    )

    const ready = await waitForReadyJson(serverMode)
    if (!ready) fail('scenario 5: restored server did not emit ready JSON')
    if (!(await waitForHttpReady(`http://127.0.0.1:${SERVER_PORT}/api/runtime/ping`))) {
      fail('scenario 5: restored server HTTP not ready')
    }
    assertNoLeak('scenario 5 ready JSON', JSON.stringify(ready))

    // Verify the seeded canvas is accessible via the protected API.
    const jwt = makeJwt(privateKey, 'workspace:read canvas:read')
    const listRes = await fetch(
      `http://127.0.0.1:${SERVER_PORT}/api/workspaces/${WORKSPACE_ID}/documents`,
      { headers: { Authorization: `Bearer ${jwt}` } },
    )
    if (!listRes.ok) fail(`scenario 5: canvas list failed with ${listRes.status}`)
    const list = await listRes.json()
    if (!(list?.documents ?? []).some((c) => c.path === CANVAS_PATH)) {
      fail('scenario 5: seeded canvas not found on restored server', {
        documentCount: (list?.documents ?? []).length,
      })
    }

    // Auth contract: unauthenticated → 401, wrong scope → 403.
    const noAuthRes = await fetch(
      `http://127.0.0.1:${SERVER_PORT}/api/workspaces/${WORKSPACE_ID}/documents`,
    )
    if (noAuthRes.status !== 401)
      fail(`scenario 5: expected 401 for no-auth, got ${noAuthRes.status}`)
    assertNoLeak('scenario 5 no-auth body', await noAuthRes.text(), SMOKE_LITERALS)

    killProc(serverMode)
    serverMode = null
    console.log(
      '[server-cli-smoke] scenario 5 PASS: restored server booted, seeded canvas verified',
    )
  }

  // ── Scenario 6: non-empty output dir is rejected ──────────────────────────

  {
    const nonEmptyOut = join(tmpRoot, 'non-empty-out')
    mkdirSync(nonEmptyOut)
    writeFileSync(join(nonEmptyOut, 'canary.txt'), 'content')

    const r = cli([
      'server',
      'backup',
      '--json',
      `--data-dir=${srcDataDir}`,
      `--output-dir=${nonEmptyOut}`,
    ])
    if (r.status === 0) fail('scenario 6: backup into non-empty output dir should have failed')
    if (r.stdout.trim() !== '') fail('scenario 6: stdout not empty on failure')
    assertNoLeak('scenario 6 stderr', r.stderr ?? '', SMOKE_LITERALS)
    console.log('[server-cli-smoke] scenario 6 PASS: non-empty output dir rejected')
  }

  // ── Scenario 7: non-empty target dir is rejected ──────────────────────────

  {
    const nonEmptyTarget = join(tmpRoot, 'non-empty-target')
    mkdirSync(nonEmptyTarget)
    writeFileSync(join(nonEmptyTarget, 'canary.txt'), 'content')

    const r = cli([
      'server',
      'restore',
      '--json',
      `--backup-dir=${backupDir}`,
      `--target-dir=${nonEmptyTarget}`,
    ])
    if (r.status === 0) fail('scenario 7: restore into non-empty target should have failed')
    if (r.stdout.trim() !== '') fail('scenario 7: stdout not empty on failure')
    assertNoLeak('scenario 7 stderr', r.stderr ?? '', SMOKE_LITERALS)
    console.log('[server-cli-smoke] scenario 7 PASS: non-empty target rejected')
  }

  // ── Scenario 8: symlink inside data dir is rejected during backup ─────────

  {
    const symlinkSrc = join(tmpRoot, 'symlink-src')
    const outsideFile = join(tmpRoot, 'outside-secret.txt')
    const symlinkOut = join(tmpRoot, 'symlink-out')
    mkdirSync(symlinkSrc)
    writeFileSync(outsideFile, 'outside-content')
    // Plant a symlink inside the data dir pointing to the outside file.
    // Node.js symlink(target, path): creates `path` → `target`.
    const { symlinkSync } = await import('node:fs')
    symlinkSync(outsideFile, join(symlinkSrc, 'evil-link.png'))

    const r = cli([
      'server',
      'backup',
      '--json',
      `--data-dir=${symlinkSrc}`,
      `--output-dir=${symlinkOut}`,
    ])
    if (r.status === 0) fail('scenario 8: backup with symlink in data dir should have failed')
    if (r.stdout.trim() !== '') fail('scenario 8: stdout not empty on failure')
    assertNoLeak('scenario 8 stderr', r.stderr ?? '', SMOKE_LITERALS)
    console.log('[server-cli-smoke] scenario 8 PASS: symlink inside data dir rejected')
  }

  // ── Scenario 9: ancestor symlink in --output-dir path is rejected ─────────

  {
    const realOut = join(tmpRoot, 'anc-real-out')
    const ancLink = join(tmpRoot, 'anc-link-out')
    const { symlinkSync } = await import('node:fs')
    mkdirSync(realOut)
    symlinkSync(realOut, ancLink)

    // Pass a path THROUGH the symlink as --output-dir so the ancestor walk
    // detects the symlink component and rejects the request.
    const r = cli([
      'server',
      'backup',
      '--json',
      `--data-dir=${srcDataDir}`,
      `--output-dir=${join(ancLink, 'backup')}`,
    ])
    if (r.status === 0)
      fail('scenario 9: backup with symlinked ancestor in output-dir should have failed')
    if (r.stdout.trim() !== '') fail('scenario 9: stdout not empty on failure')
    assertNoLeak('scenario 9 stderr', r.stderr ?? '', SMOKE_LITERALS)
    console.log('[server-cli-smoke] scenario 9 PASS: ancestor symlink in --output-dir rejected')
  }

  // ── Scenario 10: ancestor symlink in --target-dir path is rejected ────────

  {
    const realTarget = join(tmpRoot, 'anc-real-target')
    const ancLinkT = join(tmpRoot, 'anc-link-target')
    const { symlinkSync } = await import('node:fs')
    mkdirSync(realTarget)
    symlinkSync(realTarget, ancLinkT)

    const r = cli([
      'server',
      'restore',
      '--json',
      `--backup-dir=${backupDir}`,
      `--target-dir=${join(ancLinkT, 'restored')}`,
    ])
    if (r.status === 0)
      fail('scenario 10: restore with symlinked ancestor in target-dir should have failed')
    if (r.stdout.trim() !== '') fail('scenario 10: stdout not empty on failure')
    assertNoLeak('scenario 10 stderr', r.stderr ?? '', SMOKE_LITERALS)
    console.log('[server-cli-smoke] scenario 10 PASS: ancestor symlink in --target-dir rejected')
  }

  // ── Scenario 11: a running server no longer blocks a backup ──────────────

  {
    const liveDataDir = join(tmpRoot, 'live-src')
    const liveOut = join(tmpRoot, 'live-out')
    mkdirSync(liveDataDir)
    // A real database to snapshot: the one scenario 3 wrote is a VACUUM INTO
    // output, which is an ordinary self-contained database.
    writeFileSync(
      join(liveDataDir, 'whiteboard.db'),
      readFileSync(join(backupDir, 'whiteboard.db')),
    )
    // Write a server-mode.json pointing to the smoke process itself (live PID).
    writeFileSync(
      join(liveDataDir, 'server-mode.json'),
      JSON.stringify({
        schemaVersion: 1,
        pid: process.pid,
        host: '127.0.0.1',
        port: 3099,
        publicBaseUrl: SMOKE_AUDIENCE,
        authStrategy: 'oauth-jwt',
        startedAt: new Date().toISOString(),
      }),
      { mode: 0o600 },
    )

    const r = cli([
      'server',
      'backup',
      '--json',
      `--data-dir=${liveDataDir}`,
      `--output-dir=${liveOut}`,
    ])
    // This used to be a refusal, and pinning that here is what caught the
    // change (ADR-0021 decision 3). A backup requiring downtime is one an
    // operator takes rarely or never, and the interval between backups is the
    // data they lose — so a live server record is no longer a reason to stop.
    // Three things make it safe: the rows are captured through the database
    // rather than read out from under a writer, every write into the data
    // directory lands atomically, and file-GC stands down for the duration.
    if (r.status !== 0) {
      fail('scenario 11: backup of a running server should now succeed', {
        stderrBytes: (r.stderr ?? '').length,
      })
    }
    let liveJson
    try {
      liveJson = JSON.parse(r.stdout.trim())
    } catch {
      fail('scenario 11: backup stdout is not valid JSON')
    }
    if (liveJson.stores?.database?.captured !== true) {
      fail('scenario 11: rows not captured from a running deployment')
    }
    // The marker is this command's own bookkeeping and must not survive it,
    // or file-GC in that deployment never collects again.
    if (existsSync(join(liveDataDir, 'backup-in-progress.json'))) {
      fail('scenario 11: the stand-down marker was left behind')
    }
    assertNoLeak('scenario 11 stdout', r.stdout, SMOKE_LITERALS)
    assertNoLeak('scenario 11 stderr', r.stderr ?? '', SMOKE_LITERALS)
    console.log('[server-cli-smoke] scenario 11 PASS: backup taken while a server record is live')
  }

  // ── Scenario 12: running-record rejection on restore ─────────────────────

  {
    const liveTarget = join(tmpRoot, 'live-target')
    mkdirSync(liveTarget)
    writeFileSync(
      join(liveTarget, 'server-mode.json'),
      JSON.stringify({
        schemaVersion: 1,
        pid: process.pid,
        host: '127.0.0.1',
        port: 3099,
        publicBaseUrl: SMOKE_AUDIENCE,
        authStrategy: 'oauth-jwt',
        startedAt: new Date().toISOString(),
      }),
      { mode: 0o600 },
    )

    const r = cli([
      'server',
      'restore',
      '--json',
      `--backup-dir=${backupDir}`,
      `--target-dir=${liveTarget}`,
    ])
    if (r.status === 0)
      fail('scenario 12: restore into running server target should have been refused')
    if (r.stdout.trim() !== '') fail('scenario 12: stdout not empty on failure')
    if (!r.stderr?.includes('running')) fail('scenario 12: stderr should mention running')
    assertNoLeak('scenario 12 stderr', r.stderr ?? '', SMOKE_LITERALS)
    console.log('[server-cli-smoke] scenario 12 PASS: running-record restore refused')
  }
  // backup: missing --json
  {
    const r = cli(['server', 'backup', `--output-dir=${backupDir}`])
    if (r.status !== 64) fail(`scenario 13a: expected exit 64, got ${r.status}`)
    if (r.stdout.trim() !== '') fail('scenario 13a: stdout not empty on usage error')
    assertNoLeak('scenario 13a stderr', r.stderr ?? '')
  }
  // backup: missing --output-dir
  {
    const r = cli(['server', 'backup', '--json'])
    if (r.status !== 64) fail(`scenario 13b: expected exit 64, got ${r.status}`)
    if (r.stdout.trim() !== '') fail('scenario 13b: stdout not empty on usage error')
  }
  // restore: missing --json
  {
    const r = cli(['server', 'restore', `--backup-dir=${backupDir}`, `--target-dir=${restoredDir}`])
    if (r.status !== 64) fail(`scenario 13c: expected exit 64, got ${r.status}`)
  }
  // restore: missing --target-dir
  {
    const r = cli(['server', 'restore', '--json', `--backup-dir=${backupDir}`])
    if (r.status !== 64) fail(`scenario 13d: expected exit 64, got ${r.status}`)
  }
  // backup: unknown flag must not echo its value
  {
    const r = cli(['server', 'backup', '--json', '--output-dir=/o', '--unknown-flag=verysecret'])
    if (r.status !== 64) fail(`scenario 13e: expected exit 64, got ${r.status}`)
    if ((r.stderr ?? '').includes('verysecret')) {
      fail('scenario 13e: unknown flag value leaked into stderr')
    }
  }
  // restore: bare positional must not echo value
  {
    const r = cli([
      'server',
      'restore',
      '--json',
      '--backup-dir=/b',
      '--target-dir=/t',
      'bare-secret',
    ])
    if (r.status !== 64) fail(`scenario 13f: expected exit 64, got ${r.status}`)
    if ((r.stderr ?? '').includes('bare-secret')) {
      fail('scenario 13f: bare positional value leaked into stderr')
    }
  }
  console.log('[server-cli-smoke] scenario 13 PASS: usage regression ok')
  // backup routes correctly (dry-run: --data-dir pointing to valid dir succeeds arg parse)
  {
    const r = cli([
      'server',
      'backup',
      '--json',
      `--output-dir=${join(tmpRoot, 'route-test')}`,
      `--data-dir=${srcDataDir}`,
    ])
    // The backup will succeed (srcDataDir exists and outputDir is new).
    // If routing were broken, we'd get exit 64 (usage) or a JSON from a wrong subcommand.
    if (r.status !== 0 && r.status !== 1) {
      fail(`scenario 14a: unexpected exit code ${r.status}`)
    }
    if (r.status === 0) {
      let j
      try {
        j = JSON.parse(r.stdout.trim())
      } catch {
        fail('scenario 14a: invalid JSON')
      }
      if (j.operation !== 'backup') fail('scenario 14a: operation should be backup')
    }
  }
  // restore routes correctly
  {
    const r = cli([
      'server',
      'restore',
      '--json',
      `--backup-dir=${backupDir}`,
      `--target-dir=${join(tmpRoot, 'route-restore')}`,
    ])
    if (r.status !== 0 && r.status !== 1) {
      fail(`scenario 14b: unexpected exit code ${r.status}`)
    }
    if (r.status === 0) {
      let j
      try {
        j = JSON.parse(r.stdout.trim())
      } catch {
        fail('scenario 14b: invalid JSON')
      }
      if (j.operation !== 'restore') fail('scenario 14b: operation should be restore')
    }
  }
  // unknown server subcommand still exits 64 with USAGE
  {
    const r = cli(['server', 'not-a-real-subcommand', '--json'])
    if (r.status !== 64) fail(`scenario 14c: expected exit 64, got ${r.status}`)
    if (!r.stderr?.includes('server backup')) {
      fail('scenario 14c: USAGE does not list server backup')
    }
    if (!r.stderr?.includes('server restore')) {
      fail('scenario 14c: USAGE does not list server restore')
    }
  }
  console.log('[server-cli-smoke] scenario 14 PASS: dispatcher routing ok')

  // ── Scenario 14b: a shared blob mirror, and a restore from it ────────────

  // What the SCHEDULE does: every retained backup shares one copy of each
  // blob instead of carrying its own. The published CLI is what the scheduler
  // runs, so `--mirror-dir` is part of this contract — and a backup that is
  // smaller is worth nothing if it cannot be put back, so this restores it.
  {
    const sharedRoot = join(tmpRoot, 'shared-backups')
    const nightOne = join(sharedRoot, '2026-03-04T00-00-00.000Z')
    const r = cli([
      'server',
      'backup',
      '--json',
      `--data-dir=${srcDataDir}`,
      `--output-dir=${nightOne}`,
      `--mirror-dir=${sharedRoot}`,
    ])
    if (r.status !== 0) {
      fail('scenario 14b: shared-mirror backup failed', { stderrBytes: (r.stderr ?? '').length })
    }
    let manifest
    try {
      manifest = JSON.parse(readFileSync(join(nightOne, 'blobs.json'), 'utf8'))
    } catch {
      fail('scenario 14b: blob manifest is not valid JSON')
    }
    if (manifest.mirror !== 'parent')
      fail('scenario 14b: manifest does not point at the shared mirror')
    // Discriminating: the bytes would come back from a whole-tree copy too.
    // What says the mirror is carrying them is that the backup directory does
    // not.
    if (readdirSync(nightOne).includes('blobs')) {
      fail('scenario 14b: a mirrored backup still carries its own blob tree')
    }

    const restoredFromShared = join(tmpRoot, 'restored-shared')
    const rr = cli([
      'server',
      'restore',
      '--json',
      `--backup-dir=${nightOne}`,
      `--target-dir=${restoredFromShared}`,
    ])
    if (rr.status !== 0) {
      fail('scenario 14b: restore from the shared mirror failed', {
        stderrBytes: (rr.stderr ?? '').length,
      })
    }
    if (!existsSync(join(restoredFromShared, 'whiteboard.db'))) {
      fail('scenario 14b: restored data dir has no database')
    }
    console.log('[server-cli-smoke] scenario 14b PASS: shared mirror backed up and restored')
  }

  // ── Scenario 15: server support-bundle: missing record → success ────────

  {
    const bundleDataDir = join(tmpRoot, 'sb-data-missing')
    const bundleOutDir = join(tmpRoot, 'sb-out-missing')

    const r = cli([
      'server',
      'support-bundle',
      '--json',
      `--data-dir=${bundleDataDir}`,
      `--output-dir=${bundleOutDir}`,
    ])
    if (r.status !== 0) {
      fail('scenario 15: support-bundle with missing record should have succeeded', {
        stderrBytes: (r.stderr ?? '').length,
      })
    }
    let sbJson
    try {
      sbJson = JSON.parse(r.stdout.trim())
    } catch {
      fail('scenario 15: stdout is not valid JSON')
    }
    if (sbJson.schemaVersion !== 1) fail('scenario 15: schemaVersion mismatch')
    if (sbJson.ok !== true) fail('scenario 15: ok not true')
    if (sbJson.operation !== 'support-bundle') fail('scenario 15: operation mismatch')
    if (!Array.isArray(sbJson.files)) fail('scenario 15: files not an array')
    if ('outputDir' in sbJson) fail('scenario 15: outputDir must not appear in success result')

    for (const f of ['status.json', 'doctor.json', 'record.json', 'manifest.json']) {
      if (!existsSync(join(bundleOutDir, f))) fail(`scenario 15: missing bundle file ${f}`)
    }
    const manifest = JSON.parse(readFileSync(join(bundleOutDir, 'manifest.json'), 'utf-8'))
    if (manifest.mode !== 'server-mode') fail('scenario 15: manifest.mode must be server-mode')
    if (!Array.isArray(manifest.sections)) fail('scenario 15: manifest.sections missing')
    if (manifest.sections.includes('logs.jsonl'))
      fail('scenario 15: logs.jsonl must not appear in server-mode manifest')

    const scenario15Literals = [...SMOKE_LITERALS, bundleDataDir, bundleOutDir]
    assertNoLeak('scenario 15 stdout', r.stdout, scenario15Literals)
    assertNoLeak('scenario 15 stderr', r.stderr ?? '', scenario15Literals)
    const allBundleContent = ['manifest.json', 'status.json', 'doctor.json', 'record.json']
      .map((f) => readFileSync(join(bundleOutDir, f), 'utf-8'))
      .join('')
    assertNoLeak('scenario 15 bundle files', allBundleContent, scenario15Literals)
    console.log('[server-cli-smoke] scenario 15 PASS: support-bundle with missing record succeeded')
  }

  // ── Scenario 16: server support-bundle: non-empty output dir → exit 1 ────

  {
    const bundleOutNonEmpty = join(tmpRoot, 'sb-out-nonempty')
    mkdirSync(bundleOutNonEmpty)
    writeFileSync(join(bundleOutNonEmpty, 'canary.txt'), 'content')

    const r = cli([
      'server',
      'support-bundle',
      '--json',
      `--data-dir=${tmpRoot}`,
      `--output-dir=${bundleOutNonEmpty}`,
    ])
    if (r.status === 0) fail('scenario 16: non-empty output dir should have been rejected')
    if (r.stdout.trim() !== '') fail('scenario 16: stdout not empty on failure')
    if (!existsSync(join(bundleOutNonEmpty, 'canary.txt'))) {
      fail('scenario 16: canary.txt was deleted (partial write occurred)')
    }
    assertNoLeak('scenario 16 stderr', r.stderr ?? '', SMOKE_LITERALS)
    console.log('[server-cli-smoke] scenario 16 PASS: non-empty output dir rejected')
  }

  // ── Scenario 17: server support-bundle: symlink final output dir → exit 1 ─

  {
    const sbRealOut = join(tmpRoot, 'sb-real-out')
    const sbLinkOut = join(tmpRoot, 'sb-link-out')
    const { symlinkSync } = await import('node:fs')
    mkdirSync(sbRealOut)
    symlinkSync(sbRealOut, sbLinkOut)

    const r = cli([
      'server',
      'support-bundle',
      '--json',
      `--data-dir=${tmpRoot}`,
      `--output-dir=${sbLinkOut}`,
    ])
    if (r.status === 0) fail('scenario 17: symlink final output dir should have been rejected')
    if (r.stdout.trim() !== '') fail('scenario 17: stdout not empty on failure')
    assertNoLeak('scenario 17 stderr', r.stderr ?? '', SMOKE_LITERALS)
    console.log('[server-cli-smoke] scenario 17 PASS: symlink final output dir rejected')
  }

  // ── Scenario 18: server support-bundle: ancestor symlink in output path ───

  {
    const sbAncReal = join(tmpRoot, 'sb-anc-real')
    const sbAncLink = join(tmpRoot, 'sb-anc-link')
    const { symlinkSync } = await import('node:fs')
    mkdirSync(sbAncReal)
    symlinkSync(sbAncReal, sbAncLink)

    const r = cli([
      'server',
      'support-bundle',
      '--json',
      `--data-dir=${tmpRoot}`,
      `--output-dir=${join(sbAncLink, 'bundle')}`,
    ])
    if (r.status === 0)
      fail('scenario 18: ancestor symlink in output path should have been rejected')
    if (r.stdout.trim() !== '') fail('scenario 18: stdout not empty on failure')
    assertNoLeak('scenario 18 stderr', r.stderr ?? '', SMOKE_LITERALS)
    console.log('[server-cli-smoke] scenario 18 PASS: ancestor symlink in output path rejected')
  }
  // missing --json
  {
    const r = cli(['server', 'support-bundle', '--output-dir=/tmp/sb-out'])
    if (r.status !== 64) fail(`scenario 19a: expected exit 64, got ${r.status}`)
    if (r.stdout.trim() !== '') fail('scenario 19a: stdout not empty on usage error')
    assertNoLeak('scenario 19a stderr', r.stderr ?? '')
  }
  // missing --output-dir
  {
    const r = cli(['server', 'support-bundle', '--json'])
    if (r.status !== 64) fail(`scenario 19b: expected exit 64, got ${r.status}`)
    if (r.stdout.trim() !== '') fail('scenario 19b: stdout not empty on usage error')
  }
  // unknown flag must not echo its value
  {
    const r = cli([
      'server',
      'support-bundle',
      '--json',
      '--output-dir=/o',
      '--unknown-flag=verysecret',
    ])
    if (r.status !== 64) fail(`scenario 19c: expected exit 64, got ${r.status}`)
    if ((r.stderr ?? '').includes('verysecret')) {
      fail('scenario 19c: unknown flag value leaked into stderr')
    }
  }
  // bare positional must not echo value
  {
    const r = cli(['server', 'support-bundle', '--json', '--output-dir=/o', 'bare-secret'])
    if (r.status !== 64) fail(`scenario 19d: expected exit 64, got ${r.status}`)
    if ((r.stderr ?? '').includes('bare-secret')) {
      fail('scenario 19d: bare positional value leaked into stderr')
    }
  }
  console.log('[server-cli-smoke] scenario 19 PASS: usage regression ok')
  for (const { label, stdout, stderr } of leakTexts) {
    assertNoLeak(`${label} stdout`, stdout, SMOKE_LITERALS)
    assertNoLeak(`${label} stderr`, stderr, SMOKE_LITERALS)
  }
  console.log('[server-cli-smoke] scenario 20 PASS: no leaks in collected CLI output')

  // ── Scenario 21: support-bundle from running server: identity-confirmed ─────
  //
  // Boots a fresh server instance and runs support-bundle against it while it is
  // live. Verifies that status.json reflects the identity-verified running state
  // and record.json derives kind='ok' from that outcome (not from isPidAlive alone).
  {
    const BUNDLE_SERVER_PORT = 4296
    const bundleLiveDataDir = join(tmpRoot, 'sb-live-data')
    const bundleLiveOutDir = join(tmpRoot, 'sb-live-out')

    bundleServer2 = spawn(
      process.execPath,
      [
        DIST_CLI,
        'server',
        'run',
        '--json',
        `--data-dir=${bundleLiveDataDir}`,
        `--external-url=${SMOKE_AUDIENCE}`,
        '--auth-strategy=oauth-jwt',
        `--jwt-issuer=${SMOKE_ISSUER}`,
        `--jwt-audience=${SMOKE_AUDIENCE}`,
        `--jwks-uri=${jwksUri}`,
        `--allowed-origins=${SMOKE_AUDIENCE}`,
      ],
      {
        stdio: 'pipe',
        env: {
          ...scrubDevEnv(process.env),
          WHITEBOARD_SERVER_PORT: String(BUNDLE_SERVER_PORT),
          NODE_EXTRA_CA_CERTS: tlsCertFile,
        },
      },
    )

    const ready21 = await waitForReadyJson(bundleServer2)
    if (!ready21) fail('scenario 21: server did not emit ready JSON')
    if (!(await waitForHttpReady(`http://127.0.0.1:${BUNDLE_SERVER_PORT}/api/runtime/ping`))) {
      fail('scenario 21: server HTTP not ready')
    }

    const r = cli([
      'server',
      'support-bundle',
      '--json',
      `--data-dir=${bundleLiveDataDir}`,
      `--output-dir=${bundleLiveOutDir}`,
    ])
    if (r.status !== 0) {
      fail('scenario 21: support-bundle against running server failed', {
        stderrBytes: (r.stderr ?? '').length,
      })
    }
    let sbJson21
    try {
      sbJson21 = JSON.parse(r.stdout.trim())
    } catch {
      fail('scenario 21: stdout is not valid JSON')
    }
    if (sbJson21.operation !== 'support-bundle') fail('scenario 21: operation mismatch')

    // Identity-verified running state must appear in status.json.
    const status21 = JSON.parse(readFileSync(join(bundleLiveOutDir, 'status.json'), 'utf-8'))
    if (status21.state !== 'running') {
      fail(`scenario 21: status.json state should be running, got ${status21.state}`)
    }
    if (!status21.ok) fail('scenario 21: status.json ok should be true')

    // record.json kind derived from identity-verified status, not isPidAlive alone.
    const record21 = JSON.parse(readFileSync(join(bundleLiveOutDir, 'record.json'), 'utf-8'))
    if (record21.kind !== 'ok') {
      fail(`scenario 21: record.json kind should be ok (identity-verified), got ${record21.kind}`)
    }

    const scenario21Literals = [...SMOKE_LITERALS, bundleLiveDataDir, bundleLiveOutDir]
    assertNoLeak('scenario 21 stdout', r.stdout, scenario21Literals)
    const allContent21 = ['manifest.json', 'status.json', 'doctor.json', 'record.json']
      .map((f) => readFileSync(join(bundleLiveOutDir, f), 'utf-8'))
      .join('')
    assertNoLeak('scenario 21 bundle files', allContent21, scenario21Literals)

    killProc(bundleServer2)
    bundleServer2 = null
    console.log(
      '[server-cli-smoke] scenario 21 PASS: running-server bundle has identity-confirmed status/record',
    )
  }

  console.log('[server-cli-smoke] All scenarios PASSED.')
} finally {
  if (seedDaemon) killProc(seedDaemon)
  if (serverMode) killProc(serverMode)
  if (bundleServer2) killProc(bundleServer2)
  await delay(300)
  await new Promise((res) => jwksServer.close(res))
  rmSync(tmpRoot, { recursive: true, force: true })
}
