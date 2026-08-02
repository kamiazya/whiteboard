#!/usr/bin/env node
// Idempotent: probe this checkout's derived dev port (3099 on the main
// checkout, a deterministic per-worktree port otherwise — see
// dev-port-lib.mjs), and if nothing is listening start `pnpm mcp:http:dev`
// detached so the next MCP request connects immediately.
//
// Wired into client `SessionStart` hooks so opening this repo auto-launches
// the dev daemon. Re-running this script is safe; if the port is already in
// use it exits without doing anything.

import { spawn } from 'node:child_process'
import { mkdir, open } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { deriveDevPort, isMainCheckout } from './dev-port-lib.mjs'
import {
  acquireSpawnLock,
  releaseSpawnLock,
  resolveSpawnLockStaleMs,
} from './dev-spawn-lock-lib.mjs'
import {
  buildMcpHttpDevSpawnArgs,
  isSelfHealableIdentity,
  resolveDevBearerToken,
  resolveReadyTimeoutMs,
  verifyDevDaemonIdentity,
  waitForAuthenticatedMcp,
} from './ensure-http-dev-daemon-lib.mjs'
import {
  ensureDevDataDirSecured,
  readDevDaemonMarker,
  resolveDevDataDirEnv,
  resolveRepoRootFromGit,
} from './with-dev-data-dir-lib.mjs'

const REPO_ROOT = resolveRepoRootFromGit(process.cwd())
const PORT = deriveDevPort({
  repoRoot: REPO_ROOT,
  isMainCheckout: isMainCheckout(REPO_ROOT),
  env: process.env,
})
const EXPECTED_DATA_DIR = resolveDevDataDirEnv(process.env, REPO_ROOT).WHITEBOARD_DATA_DIR
const HOST = '127.0.0.1'
// Upper bound on how long we'll wait for `pnpm mcp:http:dev` to bind.
// Defaults to 30s (tsx + happy-dom + canvas + resvg cold start +
// node_modules linking can take ~10-15s on slow machines, so leave generous
// headroom — the hook is only invoked once per session start, so this isn't
// on a hot path). Overridable via WHITEBOARD_DEV_READY_TIMEOUT_MS, mainly so
// tests can exercise the timeout path without waiting 30s.
const READY_TIMEOUT_MS = resolveReadyTimeoutMs(process.env)
const READY_POLL_INTERVAL_MS = 200
// Bearer token expected by `/mcp`. Must match the value the local clients
// (.claude/settings.json, .codex/config.toml) send. If a different daemon
// (or a non-whiteboard service) is on the port we'll see 401 / 4xx and
// refuse to claim success.
// Set WHITEBOARD_TOKEN in the shell to use a custom token consistently across
// the browser (vite-dev-token-plugin.ts) and this probe. When a custom value
// is set the spawned daemon receives an explicit --token flag that overrides
// the default baked into the pnpm script, keeping all three in sync.
const DEV_BEARER_TOKEN = resolveDevBearerToken(process.env)
const LOG_DIR = join(REPO_ROOT, 'tmp', 'logs')
const LOG_PATH = join(LOG_DIR, 'mcp-http-dev.log')
const QUIET = process.argv.includes('--quiet')

function info(message) {
  if (!QUIET) console.log(message)
}

// process.kill(pid, 0) throws (ESRCH) when no process with that pid exists;
// it does not actually send a signal. This is the standard cross-platform
// liveness check pattern.
function isPidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function probe(port) {
  // Try to occupy the port. If EADDRINUSE, something else is already there.
  return new Promise((resolveProbe) => {
    const tester = createServer()
    tester.once('error', (err) => {
      if (err.code === 'EADDRINUSE') resolveProbe('in-use')
      else resolveProbe('error')
    })
    tester.once('listening', () => tester.close(() => resolveProbe('free')))
    tester.listen(port, HOST)
  })
}

// Probe `/mcp` with the dev bearer token + a JSON-RPC initialize request.
// Confirms three things at once: (1) something is on the port, (2) it
// accepts our bearer (so .claude / .codex auth headers will succeed),
// (3) it speaks JSON-RPC (so it isn't an unrelated local service that
// happens to grab port 3099).
async function probeAuthenticatedMcpDaemon() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 3_000)
  try {
    const res = await fetch(`http://${HOST}:${PORT}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${DEV_BEARER_TOKEN}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'ensure-http-dev-daemon',
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'ensure-http-dev-daemon', version: '0.0.0' },
        },
      }),
      signal: controller.signal,
    })
    if (res.status === 401 || res.status === 403) return 'wrong-token'
    if (!res.ok) return 'not-mcp'
    // Accept either application/json (synchronous response) or
    // text/event-stream (streamed transport). Anything else is some other
    // service answering 200 by coincidence.
    const ct = (res.headers.get('content-type') ?? '').toLowerCase()
    if (!ct.includes('application/json') && !ct.includes('text/event-stream')) {
      return 'not-mcp'
    }
    return 'ours'
  } catch {
    return 'unreachable'
  } finally {
    clearTimeout(timer)
  }
}

// Runs the probe + identity-verification sequence and returns a verdict
// instead of acting on it directly, so the same assessment can run twice:
// once unlocked (the fast path — "is our daemon already healthy?") and
// once again under the spawn lock (the decisive assessment a winner makes
// right before choosing to spawn). Neither pass ever mutates state.
async function assessDaemon() {
  const status = await probe(PORT)
  if (status !== 'in-use') {
    return { kind: 'free' }
  }
  // Something is on the port. It might be our dev daemon from a previous
  // session, an old whiteboard daemon spawned by the stdio path with a
  // different token, or an unrelated local service that grabbed 3099.
  // Treating any of these as "OK, keep going" silently breaks the next
  // MCP connection, so verify it's actually our authenticated daemon
  // before claiming success.
  const verdict = await probeAuthenticatedMcpDaemon()
  if (verdict === 'ours') {
    // An authenticated MCP daemon answers on our derived port — but with a
    // shared default bearer token across worktrees, that alone doesn't rule
    // out a hash-collision daemon from a DIFFERENT worktree. Cross-check
    // against this worktree's own marker before claiming success.
    const identity = verifyDevDaemonIdentity({
      marker: readDevDaemonMarker(EXPECTED_DATA_DIR),
      expectedPort: PORT,
      expectedRepoRoot: REPO_ROOT,
      isPidAlive,
    })
    if (identity === 'ours') {
      return { kind: 'healthy', message: `http://${HOST}:${PORT} already listening — verified` }
    }
    if (isSelfHealableIdentity(identity)) {
      // A marker-less daemon on our own derived port predates this feature
      // (or predates its own first marker write) — not evidence of a
      // foreign daemon. A "stale" marker (port + repoRoot match, recorded
      // pid dead) means the with-dev-data-dir wrapper that owned that pid
      // died abnormally while its spawned server child kept the port
      // bound — also this worktree's own daemon, not a foreign one. Both
      // self-heal instead of hard-failing.
      const reason =
        identity === 'stale'
          ? 'its recorded pid is no longer running (the dev wrapper likely crashed or was killed without cleanup, but the daemon itself is still up)'
          : 'no identity marker was found (daemon predates this check)'
      return {
        kind: 'healthy',
        message:
          `http://${HOST}:${PORT} already listening — ${reason}; ` +
          "assuming it is this worktree's own daemon",
      }
    }
    return {
      kind: 'conflict',
      message:
        `http://${HOST}:${PORT} answers MCP but its ` +
        `${EXPECTED_DATA_DIR}/dev-daemon.json marker does not match this worktree ` +
        '(a different port or repo root is recorded). ' +
        "This is very likely a different worktree's daemon that hash-collided on this port. " +
        'Set WHITEBOARD_DEV_PORT to a distinct value for one of the worktrees, or stop the ' +
        'conflicting process (e.g. `pkill -f mcp:http:dev`) and rerun.',
    }
  }
  const why =
    {
      'wrong-token': 'rejected the dev bearer token (likely a stale daemon with a different token)',
      'not-mcp': 'is not speaking MCP',
    }[verdict] ?? 'did not respond to a probe'
  return {
    kind: 'conflict',
    message: `http://${HOST}:${PORT} is in use but ${why}. Stop the conflicting process (e.g. \`pkill -f mcp:http:dev\`) and rerun.`,
  }
}

// UNLOCKED fast path. When a healthy authenticated daemon with a matching
// identity is already up, exit without ever touching the lock — this is
// the common case on every session start after the first, and it must
// stay a pure read: no lock file created, no state left behind.
const fastAssessment = await assessDaemon()
if (fastAssessment.kind === 'healthy') {
  info(`[ensure-http-dev-daemon] ${fastAssessment.message}`)
  process.exit(0)
}

ensureDevDataDirSecured(EXPECTED_DATA_DIR)
const LOCK_PATH = join(EXPECTED_DATA_DIR, 'dev-daemon-spawn.lock')
const SPAWN_LOCK_STALE_MS = resolveSpawnLockStaleMs(process.env)
const lockMeta = {
  pid: process.pid,
  startedAt: new Date().toISOString(),
  port: PORT,
  repoRoot: REPO_ROOT,
}

// Single release path: every exit below goes through process.exit(), so
// releasing here covers them all (release only unlinks a lock that still
// records our own pid, so it can never clobber a successor). Correctness
// never depends on this running; the staleness window in acquireSpawnLock
// is the backstop for a process that dies without reaching it (SIGKILL).
process.on('exit', () => {
  releaseSpawnLock({ lockPath: LOCK_PATH, ownerPid: process.pid })
})

function tryAcquireLock() {
  return acquireSpawnLock({
    lockPath: LOCK_PATH,
    meta: lockMeta,
    staleAfterMs: SPAWN_LOCK_STALE_MS,
    isPidAlive,
  })
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function failReadyTimeout(detail = '') {
  console.error(
    `[ensure-http-dev-daemon] timed out waiting for authenticated MCP at http://${HOST}:${PORT} after ${READY_TIMEOUT_MS}ms${detail} — see ${LOG_PATH}. ` +
      'MCP tools will be unavailable for this session.',
  )
  process.exit(1)
}

// WINNER: acquired the spawn lock. Re-run the assessment now that we hold
// exclusive access — probe-decide-spawn must be one atomic sequence, and
// this is the decisive pass that actually acts on its verdict.
async function runAsWinner() {
  const assessment = await assessDaemon()
  if (assessment.kind === 'healthy') {
    info(`[ensure-http-dev-daemon] ${assessment.message}`)
    process.exit(0)
  }
  if (assessment.kind === 'conflict') {
    console.error(`[ensure-http-dev-daemon] ${assessment.message}`)
    process.exit(1)
  }

  await mkdir(LOG_DIR, { recursive: true })
  const logFile = await open(LOG_PATH, 'a')
  const pnpmCmd = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

  const child = spawn(pnpmCmd, buildMcpHttpDevSpawnArgs(DEV_BEARER_TOKEN, PORT), {
    cwd: REPO_ROOT,
    detached: true,
    stdio: ['ignore', logFile.fd, logFile.fd],
    env: process.env,
  })
  child.on('error', (err) => {
    console.error(`[ensure-http-dev-daemon] failed to spawn ${pnpmCmd}: ${err.message}`)
    process.exit(1)
  })
  await logFile.close()

  // Wait for the daemon to actually accept connections before letting the
  // hook return. Without this, an MCP client started right after the hook
  // can race the daemon's bind and see ECONNREFUSED while the script
  // reports success.
  let exitedEarly = false
  let exitCode = null
  child.once('exit', (code) => {
    exitedEarly = true
    exitCode = code
  })
  const ready = await waitForAuthenticatedMcp({
    probe: probeAuthenticatedMcpDaemon,
    sleep,
    timeoutMs: READY_TIMEOUT_MS,
    pollIntervalMs: READY_POLL_INTERVAL_MS,
  })
  if (!ready) {
    failReadyTimeout(exitedEarly ? `; spawned process exited with code ${exitCode}` : '')
  }

  // The initial assessment saw the port free, but another worktree's hook
  // can win a startup race and bind the same derived port between that
  // assessment and our own spawn becoming ready (TOCTOU). An authenticated
  // MCP response alone doesn't prove it's OUR spawn that answered —
  // cross-check the identity marker before declaring success.
  const postSpawnIdentity = verifyDevDaemonIdentity({
    marker: readDevDaemonMarker(EXPECTED_DATA_DIR),
    expectedPort: PORT,
    expectedRepoRoot: REPO_ROOT,
    isPidAlive,
  })
  if (postSpawnIdentity !== 'ours' && !isSelfHealableIdentity(postSpawnIdentity)) {
    console.error(
      `[ensure-http-dev-daemon] http://${HOST}:${PORT} answered MCP right after we spawned our own ` +
        `daemon, but its ${EXPECTED_DATA_DIR}/dev-daemon.json marker does not match this worktree ` +
        '(a different port or repo root is recorded). ' +
        'This is very likely a startup race with another worktree that bound the same derived port ' +
        'first. Rerun this hook; if it keeps happening, set WHITEBOARD_DEV_PORT to a distinct value ' +
        'for one of the worktrees.',
    )
    process.exit(1)
  }

  // Detach now that we know the daemon is up — keeps the parent shell free
  // to disconnect without taking the child down with it.
  child.unref()
  info(
    `[ensure-http-dev-daemon] started ${pnpmCmd} mcp:http:dev (pid ${child.pid}) — log: ${LOG_PATH}`,
  )
  process.exit(0)
}

// LOSER: another process holds the spawn lock. This process's session
// still needs a working daemon regardless of who starts it, so it waits
// for the daemon to become reachable — the same wait the winner does —
// instead of exiting immediately. On each poll it also retries
// acquisition: if the holder died before spawning (a dead recorded pid
// makes its lock immediately stale), this process promotes itself to
// winner and finishes the job itself rather than the developer's session
// staying stuck behind a corpse.
async function runAsLoser() {
  const startedAt = Date.now()
  while (Date.now() - startedAt < READY_TIMEOUT_MS) {
    // Route through assessDaemon (not the raw probe) so a bare 'ours' bearer
    // match still gets the identity-marker cross-check every other success
    // path performs — with a shared default bearer token across worktrees,
    // an authenticated response alone doesn't rule out a different
    // worktree's daemon that hash-collided on this derived port.
    const waitingAssessment = await assessDaemon()
    if (waitingAssessment.kind === 'healthy') {
      info(
        `[ensure-http-dev-daemon] http://${HOST}:${PORT} became reachable while waiting for another process's spawn`,
      )
      process.exit(0)
    }
    if (tryAcquireLock() === 'acquired') {
      await runAsWinner()
      return
    }
    await sleep(READY_POLL_INTERVAL_MS)
  }
  failReadyTimeout()
}

if (tryAcquireLock() === 'acquired') {
  await runAsWinner()
} else {
  await runAsLoser()
}
