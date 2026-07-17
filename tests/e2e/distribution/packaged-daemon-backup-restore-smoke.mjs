#!/usr/bin/env node
// Packaged backup / restore smoke. Locks the end-to-end contract that
// a backed-up daemon data dir, restored into a fresh location, can
// boot the packaged daemon and serve the same workspace + canvas
// state that the source dir held. The store-level drill in
// `backup-restore.test.ts` covers the helper's filesystem invariants;
// this script adds the distribution-layer guarantee that the dist
// daemon + dist CLI both honour the restored dir.
//
// Flow:
//   1. Spawn daemon A at <src>. Use HTTP API to seed a real canvas
//      (workspace metadata + DB row + Loro snapshot through the live
//      daemon, not via fixture writes).
//   2. Stop daemon A cleanly via `whiteboard daemon stop --json`.
//   3. backupDataDir(src, backup) → restoreDataDir(backup, restored).
//   4. Spawn daemon B at <restored> on a different port. Verify ping,
//      runtime status, and that the seeded canvas survives the round
//      trip via the live daemon (NOT via fixture reads).
//   5. CLI status against <restored> reports a fresh record matching
//      daemon B's pid / port / baseUrl.
//   6. Token must never reach daemon stdout/stderr, runtime status
//      body, or CLI output.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { assertNoLeak, scrubDevEnv } from './smoke-helpers.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..', '..')

// 4290/4291 are picked to keep this smoke off the ports the other
// distribution smokes already claim (4270 startup, 4280 lifecycle)
// AND off the browser E2E layer (4250 vite, 4260 daemon) so the full
// `pnpm test:e2e:distribution` chain can run back-to-back without
// bind collisions.
const HOST = '127.0.0.1'
const PORT_A = 4290
const PORT_B = 4291
const TOKEN_A = 'whiteboard-backup-restore-smoke-token-a'
const TOKEN_B = 'whiteboard-backup-restore-smoke-token-b'
const READINESS_TIMEOUT_MS = 15_000
const READINESS_INTERVAL_MS = 200
const SHUTDOWN_TIMEOUT_MS = 5_000
const SEED_CANVAS_SLUG = 'canvas-backup-restore-smoke'
// Fixed workspace id seeded by this smoke. `sess-...` follows the
// project's `[A-Za-z0-9_-]+` rule. Creating a canvas under this id
// inserts both the workspace row and the canvas row through the
// real daemon, so the backup includes a workspace that
// `/api/workspaces` can list back.
const WORKSPACE_ID = 'sess-backup-restore-smoke'

const DAEMON_ENTRY = resolve(REPO_ROOT, 'packages/mcp-server/dist/server/index.js')
const CLI_ENTRY = resolve(REPO_ROOT, 'packages/mcp-server/dist/cli/index.js')
const BACKUP_ENTRY = resolve(REPO_ROOT, 'packages/mcp-server/dist/server/backup-restore.js')

function dump(message, ctx = {}) {
  console.error(`[packaged-daemon-backup-restore-smoke] FAIL: ${message}`)
  for (const [key, value] of Object.entries(ctx)) {
    if (value === undefined || value === '') continue
    console.error(`---- ${key} ----`)
    console.error(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
  }
}

for (const entry of [DAEMON_ENTRY, CLI_ENTRY, BACKUP_ENTRY]) {
  if (!existsSync(entry)) {
    dump(`dist artifact missing: ${entry}\nRun \`pnpm --filter @kamiazya/whiteboard-mcp build\`.`)
    process.exit(1)
  }
}

const tempRoot = mkdtempSync(join(tmpdir(), 'whiteboard-backup-restore-smoke-'))
const srcDataDir = join(tempRoot, 'src')
const backupDir = join(tempRoot, 'backup')
const restoredDataDir = join(tempRoot, 'restored')

const daemons = []

function startDaemon({ dataDir, port, token, label }) {
  let stdoutBuf = ''
  let stderrBuf = ''
  let spawnError = null
  const child = spawn(
    process.execPath,
    [DAEMON_ENTRY, '--daemon', `--host=${HOST}`, `--port=${port}`],
    {
      cwd: REPO_ROOT,
      env: {
        ...scrubDevEnv(process.env),
        WHITEBOARD_DATA_DIR: dataDir,
        // DAEMON_ENTRY is invoked directly (not via `whiteboard daemon run`),
        // so the token is read by resolveToken() in server/index.ts, which
        // only honours --token= or WHITEBOARD_TOKEN — WHITEBOARD_DAEMON_TOKEN
        // (the env var the `daemon run` CLI subcommand reads instead) is a
        // no-op here. Passing the wrong name meant `daemonMode && token` was
        // always false, so the daemon never wrote its registry record, and
        // every later `whiteboard daemon stop` for this dir failed with
        // "record-not-found".
        WHITEBOARD_TOKEN: token,
        WHITEBOARD_LOG_LEVEL: process.env.WHITEBOARD_LOG_LEVEL ?? 'warning',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  child.stdout.on('data', (c) => {
    stdoutBuf += c.toString()
  })
  child.stderr.on('data', (c) => {
    stderrBuf += c.toString()
  })
  child.on('error', (err) => {
    spawnError = err
  })
  let exitCode = null
  let exitSignal = null
  const closed = new Promise((res) => {
    child.once('close', (code, signal) => {
      exitCode = code
      exitSignal = signal
      res({ code, signal })
    })
  })
  const handle = {
    label,
    child,
    port,
    token,
    dataDir,
    closed,
    get spawnError() {
      return spawnError
    },
    get exitCode() {
      return exitCode
    },
    get exitSignal() {
      return exitSignal
    },
    get stdoutBuf() {
      return stdoutBuf
    },
    get stderrBuf() {
      return stderrBuf
    },
  }
  daemons.push(handle)
  return handle
}

async function pollPing(daemon) {
  const deadline = Date.now() + READINESS_TIMEOUT_MS
  let lastErr = null
  while (Date.now() < deadline) {
    if (daemon.spawnError) {
      throw new Error(`${daemon.label} failed to spawn: ${daemon.spawnError.message}`)
    }
    if (daemon.exitCode !== null) {
      throw new Error(
        `${daemon.label} exited before becoming ready (code=${daemon.exitCode}, signal=${daemon.exitSignal})`,
      )
    }
    try {
      const res = await fetch(`http://${HOST}:${daemon.port}/api/runtime/ping`)
      if (!res.ok) throw new Error(`ping returned status ${res.status}`)
      return await res.json()
    } catch (err) {
      lastErr = err
      await delay(READINESS_INTERVAL_MS)
    }
  }
  throw new Error(
    `${daemon.label} never answered /api/runtime/ping within ${READINESS_TIMEOUT_MS}ms` +
      (lastErr ? `: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}` : ''),
  )
}

async function authedFetch(daemon, path, init = {}) {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${daemon.token}`)
  return fetch(`http://${HOST}:${daemon.port}${path}`, { ...init, headers })
}

async function shutdownDaemon(daemon) {
  if (daemon.exitCode !== null) return
  if (daemon.spawnError) {
    await daemon.closed.catch(() => undefined)
    return
  }
  daemon.child.kill('SIGTERM')
  const winner = await Promise.race([daemon.closed, delay(SHUTDOWN_TIMEOUT_MS, 'timeout')])
  if (winner === 'timeout') {
    daemon.child.kill('SIGKILL')
    await daemon.closed
  }
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    encoding: 'utf-8',
    env: scrubDevEnv(process.env),
  })
}

// assertNoLeak (BASE_LEAK_PATTERNS) is imported from smoke-helpers.mjs.
// Call sites pass the per-daemon token as extraLiterals: assertNoLeak(label, text, [token]).

try {
  console.log(`[packaged-daemon-backup-restore-smoke] temp root → ${tempRoot}`)
  console.log(`[packaged-daemon-backup-restore-smoke] src → ${srcDataDir}`)
  console.log(`[packaged-daemon-backup-restore-smoke] restored → ${restoredDataDir}`)

  // ───────── Phase 1: seed via daemon A ─────────
  const daemonA = startDaemon({
    dataDir: srcDataDir,
    port: PORT_A,
    token: TOKEN_A,
    label: 'daemon A (src)',
  })
  await pollPing(daemonA)
  console.log(`[packaged-daemon-backup-restore-smoke] daemon A ready (pid=${daemonA.child.pid})`)

  // Seed a canvas under a known workspaceId through the live daemon
  // — this writes the workspace row, canvas row, and Loro snapshot
  // through the real DB + filesystem stores, NOT via fixture writes.
  const createRes = await authedFetch(
    daemonA,
    `/api/workspaces/${encodeURIComponent(WORKSPACE_ID)}/canvases`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: SEED_CANVAS_SLUG }),
    },
  )
  if (!createRes.ok) {
    const t = await createRes.text().catch(() => '')
    throw new Error(`seed canvas POST failed: ${createRes.status} ${t}`)
  }

  // /api/workspaces only returns workspace rows the daemon has
  // observed. After the canvas POST above the workspace row is
  // present, so the listing must include our seeded id.
  const wsListA = await (await authedFetch(daemonA, '/api/workspaces')).json()
  const workspaceIdsA = (wsListA?.workspaces ?? []).map((w) => w.workspaceId)
  if (!workspaceIdsA.includes(WORKSPACE_ID)) {
    throw new Error(
      `seeded workspaceId not present in daemon A list: ${JSON.stringify(workspaceIdsA)}`,
    )
  }

  const seededList = await (
    await authedFetch(daemonA, `/api/workspaces/${encodeURIComponent(WORKSPACE_ID)}/canvases`)
  ).json()
  const seededSlugs = (seededList?.canvases ?? []).map((c) => c.slug)
  if (!seededSlugs.includes(SEED_CANVAS_SLUG)) {
    throw new Error(`seeded canvas not present after POST: ${JSON.stringify(seededSlugs)}`)
  }
  console.log(`[packaged-daemon-backup-restore-smoke] seeded workspaceId → ${WORKSPACE_ID}`)

  // Capture the canvas Loro snapshot through daemon A's HTTP route
  // BEFORE stopping it. The route reads from
  // `blobs/<wsId>/canvas/<canvasId>.loro` via the canvas-store —
  // that's exactly the file path the backup helper has to round-trip
  // through restore. Comparing daemon B's snapshot bytes to this
  // baseline catches a regression that drops `blobs/` from the
  // backup or restore copy: even if the DB row survived, the file
  // body would either be missing or a fresh empty doc and the bytes
  // would no longer match.
  const snapshotARes = await authedFetch(
    daemonA,
    `/api/canvas/${encodeURIComponent(WORKSPACE_ID)}/${encodeURIComponent(SEED_CANVAS_SLUG)}/snapshot`,
  )
  if (!snapshotARes.ok) {
    throw new Error(`daemon A snapshot fetch failed: ${snapshotARes.status}`)
  }
  const seededSnapshot = new Uint8Array(await snapshotARes.arrayBuffer())
  if (seededSnapshot.byteLength === 0) {
    throw new Error('daemon A snapshot bytes are empty — seed did not produce a Loro snapshot')
  }
  console.log(
    `[packaged-daemon-backup-restore-smoke] seed snapshot bytes → ${seededSnapshot.byteLength}`,
  )

  // Stop daemon A cleanly via the packaged CLI so daemon.json is
  // closed up the same way a real user's machine would.
  const stopA = await new Promise((res) => {
    const proc = spawn(
      process.execPath,
      [CLI_ENTRY, 'daemon', 'stop', '--json', `--data-dir=${srcDataDir}`],
      { stdio: ['ignore', 'pipe', 'pipe'], env: scrubDevEnv(process.env) },
    )
    let out = ''
    let err = ''
    proc.stdout.on('data', (c) => {
      out += c.toString()
    })
    proc.stderr.on('data', (c) => {
      err += c.toString()
    })
    proc.on('close', (status) => res({ status, stdout: out, stderr: err }))
  })
  if (stopA.status !== 0) {
    throw new Error(`daemon A stop failed: ${stopA.status} ${stopA.stderr}`)
  }
  assertNoLeak('daemon A stop stdout', stopA.stdout, [TOKEN_A])
  assertNoLeak('daemon A stop stderr', stopA.stderr, [TOKEN_A])
  await daemonA.closed
  console.log('[packaged-daemon-backup-restore-smoke] daemon A stopped cleanly')

  // ───────── Phase 2: backup + restore ─────────
  const { backupDataDir, restoreDataDir } = await import(`file://${BACKUP_ENTRY}`)
  await backupDataDir(srcDataDir, backupDir, { allowedRoots: [tempRoot] })

  // Non-destructive: src must still hold its contents after backup.
  if (!existsSync(join(srcDataDir, 'whiteboard.db'))) {
    throw new Error('source data dir missing whiteboard.db after backup')
  }
  const srcEntriesAfterBackup = readdirSync(srcDataDir).sort()
  if (srcEntriesAfterBackup.length === 0) {
    throw new Error('source data dir is empty after backup')
  }

  await restoreDataDir(backupDir, restoredDataDir, { allowedRoots: [tempRoot] })
  if (!existsSync(join(restoredDataDir, 'whiteboard.db'))) {
    throw new Error('restored data dir missing whiteboard.db')
  }
  const restoredEntries = readdirSync(restoredDataDir).sort()
  if (JSON.stringify(restoredEntries) !== JSON.stringify(srcEntriesAfterBackup)) {
    throw new Error(
      `restored entries differ from source after restore.\n  src: ${JSON.stringify(srcEntriesAfterBackup)}\n  restored: ${JSON.stringify(restoredEntries)}`,
    )
  }
  console.log('[packaged-daemon-backup-restore-smoke] backup → restore ok (entries match)')

  // ───────── Phase 3: boot daemon B against restored dir ─────────
  const daemonB = startDaemon({
    dataDir: restoredDataDir,
    port: PORT_B,
    token: TOKEN_B,
    label: 'daemon B (restored)',
  })
  await pollPing(daemonB)
  console.log(`[packaged-daemon-backup-restore-smoke] daemon B ready (pid=${daemonB.child.pid})`)

  const statusBRes = await authedFetch(daemonB, '/api/runtime/status')
  if (!statusBRes.ok) throw new Error(`daemon B /status: ${statusBRes.status}`)
  const statusBText = await statusBRes.text()
  assertNoLeak('runtime status B', statusBText, [TOKEN_B])
  const statusB = JSON.parse(statusBText)
  if (statusB.storage?.dataDir !== restoredDataDir) {
    throw new Error(
      `daemon B storage.dataDir expected ${restoredDataDir}, got ${statusB.storage?.dataDir}`,
    )
  }
  if (statusB.auth?.hasToken !== true) {
    throw new Error(`daemon B auth.hasToken expected true, got ${statusB.auth?.hasToken}`)
  }
  if (statusB.pid !== daemonB.child.pid) {
    throw new Error(`daemon B status pid ${statusB.pid} !== spawned ${daemonB.child.pid}`)
  }

  // The restored DB must surface the same workspace + canvas.
  const wsListB = await (await authedFetch(daemonB, '/api/workspaces')).json()
  const workspaceIdsB = (wsListB?.workspaces ?? []).map((w) => w.workspaceId)
  if (!workspaceIdsB.includes(WORKSPACE_ID)) {
    throw new Error(
      `restored daemon does not surface seeded workspaceId ${WORKSPACE_ID}: ${JSON.stringify(workspaceIdsB)}`,
    )
  }
  const restoredCanvases = await (
    await authedFetch(daemonB, `/api/workspaces/${encodeURIComponent(WORKSPACE_ID)}/canvases`)
  ).json()
  const restoredSlugs = (restoredCanvases?.canvases ?? []).map((c) => c.slug)
  if (!restoredSlugs.includes(SEED_CANVAS_SLUG)) {
    throw new Error(`restored daemon missing seeded canvas: ${JSON.stringify(restoredSlugs)}`)
  }
  console.log(
    `[packaged-daemon-backup-restore-smoke] restored data round-tripped (workspace=${WORKSPACE_ID}, canvas=${SEED_CANVAS_SLUG})`,
  )

  // Loro snapshot byte-equality. Without this assertion a regression
  // that copies the DB but drops `blobs/` (where the canvas's `.loro`
  // file lives) could still pass the workspace + canvas list checks
  // above — the DB row would be intact even though the on-disk
  // snapshot was lost. Reading the snapshot through the route forces
  // daemon B to actually `loadCanvas` the restored file.
  const snapshotBRes = await authedFetch(
    daemonB,
    `/api/canvas/${encodeURIComponent(WORKSPACE_ID)}/${encodeURIComponent(SEED_CANVAS_SLUG)}/snapshot`,
  )
  if (!snapshotBRes.ok) {
    throw new Error(`daemon B snapshot fetch failed: ${snapshotBRes.status}`)
  }
  const restoredSnapshot = new Uint8Array(await snapshotBRes.arrayBuffer())
  if (restoredSnapshot.byteLength === 0) {
    throw new Error('daemon B snapshot bytes are empty — restored blob is missing or unreadable')
  }
  if (restoredSnapshot.byteLength !== seededSnapshot.byteLength) {
    throw new Error(
      `restored snapshot byte length ${restoredSnapshot.byteLength} != seeded ${seededSnapshot.byteLength}`,
    )
  }
  for (let i = 0; i < seededSnapshot.byteLength; i++) {
    if (restoredSnapshot[i] !== seededSnapshot[i]) {
      throw new Error(`restored snapshot byte mismatch at index ${i}`)
    }
  }
  // Byte equality through `loadCanvas → doc.export({ mode: 'snapshot' })`
  // means daemon B successfully read the restored
  // `blobs/<wsId>/canvas/<canvasId>.loro` file. The Loro runtime
  // itself is exercised by the existing canvas-store integration
  // tests; here byte equality is sufficient to catch a regression
  // that drops `blobs/` from the backup or restore copy or that
  // points the restored DB row at a different canvasId.
  console.log(
    `[packaged-daemon-backup-restore-smoke] snapshot round-trip ok (${seededSnapshot.byteLength} bytes)`,
  )

  // ───────── Phase 4: packaged CLI status against restored dir ─────────
  const cliRun = runCli(['daemon', 'status', '--json', `--data-dir=${restoredDataDir}`])
  if (cliRun.status !== 0) {
    throw new Error(
      `whiteboard daemon status --json (restored) exited ${cliRun.status}\n` +
        `stdout: ${cliRun.stdout}\nstderr: ${cliRun.stderr}`,
    )
  }
  assertNoLeak('cli status stdout', cliRun.stdout, [TOKEN_B])
  assertNoLeak('cli status stderr', cliRun.stderr, [TOKEN_B])
  const cliResult = JSON.parse(cliRun.stdout.trim())
  // `whiteboard daemon status --json` (see daemon-status.ts DaemonStatusResult)
  // has never had a top-level baseUrl field — only record.port/pid. Derive
  // the expected base URL from record.port instead of asserting a field the
  // CLI contract does not emit.
  const cliExpectations = [
    ['ok', cliResult.ok, true],
    ['reason', cliResult.reason, null],
    ['recordFresh', cliResult.recordFresh, true],
    ['record.pid', cliResult.record?.pid, daemonB.child.pid],
    ['record.port', cliResult.record?.port, PORT_B],
    [
      'derived baseUrl (host + record.port)',
      `http://${HOST}:${cliResult.record?.port}`,
      `http://${HOST}:${PORT_B}`,
    ],
  ]
  for (const [field, actual, expected] of cliExpectations) {
    if (actual !== expected) {
      throw new Error(
        `cli result.${field} mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
      )
    }
  }
  console.log('[packaged-daemon-backup-restore-smoke] cli status ok against restored dir')

  // ───────── Phase 5: stop daemon B ─────────
  const stopB = await new Promise((res) => {
    const proc = spawn(
      process.execPath,
      [CLI_ENTRY, 'daemon', 'stop', '--json', `--data-dir=${restoredDataDir}`],
      { stdio: ['ignore', 'pipe', 'pipe'], env: scrubDevEnv(process.env) },
    )
    let out = ''
    let err = ''
    proc.stdout.on('data', (c) => {
      out += c.toString()
    })
    proc.stderr.on('data', (c) => {
      err += c.toString()
    })
    proc.on('close', (status) => res({ status, stdout: out, stderr: err }))
  })
  if (stopB.status !== 0) {
    throw new Error(`daemon B stop failed: ${stopB.status} ${stopB.stderr}`)
  }
  assertNoLeak('daemon B stop stdout', stopB.stdout, [TOKEN_B])
  assertNoLeak('daemon B stop stderr', stopB.stderr, [TOKEN_B])
  await daemonB.closed
  console.log('[packaged-daemon-backup-restore-smoke] daemon B stopped cleanly')

  // ───────── Final daemon-side leak guards ─────────
  for (const daemon of daemons) {
    assertNoLeak(`${daemon.label} stdout`, daemon.stdoutBuf, [daemon.token])
    assertNoLeak(`${daemon.label} stderr`, daemon.stderrBuf, [daemon.token])
  }

  console.log('[packaged-daemon-backup-restore-smoke] OK')
} catch (err) {
  process.exitCode = 1
  dump(err instanceof Error ? err.message : String(err), {
    'daemon A stdout': daemons[0]?.stdoutBuf ?? '',
    'daemon A stderr': daemons[0]?.stderrBuf ?? '',
    'daemon B stdout': daemons[1]?.stdoutBuf ?? '',
    'daemon B stderr': daemons[1]?.stderrBuf ?? '',
  })
} finally {
  for (const daemon of daemons) {
    await shutdownDaemon(daemon).catch(() => {})
  }
  rmSync(tempRoot, { recursive: true, force: true })
}
