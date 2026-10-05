#!/usr/bin/env node
// Idempotent: if this checkout's dev daemon is not answering, start
// `pnpm mcp:http:dev` detached and wait until it does, so the next MCP
// request connects immediately.
//
// "Answering" means the daemon record in this checkout's data dir names a
// socket, and /api/runtime/ping answers on it (ADR-0050 decision 2). The
// socket path hashes the data dir and every checkout has its own data dir, so
// whatever answers there is this checkout's own daemon — no derived port is
// consulted. A daemon that is running (assessRecordedDaemon) but too busy to
// answer is waited for, never doubled.
//
// Wired into client `SessionStart` hooks so opening this repo auto-launches
// the dev daemon. Re-running this script is safe.

import { spawn } from 'node:child_process'
import { mkdir, open, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseScriptArgs } from '../../../../.claude/scripts/script-flags.mjs'
import {
  answersPing,
  assessRecordedDaemon,
  isPidAlive,
  PING_TIMEOUT_MS,
  readDaemonRecord,
} from './dev-daemon-socket-lib.mjs'
import {
  acquireSpawnLock,
  releaseSpawnLock,
  resolveSpawnLockStaleMs,
} from './dev-spawn-lock-lib.mjs'
import {
  buildMcpHttpDevSpawnArgs,
  describeTokenConflict,
  refusalLine,
  resolveDevBearerToken,
  resolveReadyTimeoutMs,
  waitForDaemon,
} from './ensure-http-dev-daemon-lib.mjs'
import {
  ensureDevDataDirSecured,
  resolveDevDataDirEnv,
  resolveHookProjectRoot,
} from './with-dev-data-dir-lib.mjs'

// Parsed before any state is read: an unrecognised flag must never fall through to starting a daemon.
const { flags } = parseScriptArgs({
  argv: process.argv.slice(2),
  flags: ['--quiet'],
  usage:
    "usage: ensure-http-dev-daemon.mjs [--quiet]  (starts this checkout's dev daemon unless one answers)",
})

const REPO_ROOT = resolveHookProjectRoot(process.env, process.cwd())
const EXPECTED_DATA_DIR = resolveDevDataDirEnv(process.env, REPO_ROOT).WHITEBOARD_DATA_DIR
// Upper bound on how long we'll wait for `pnpm mcp:http:dev` to answer.
// Defaults to 30s (tsx + happy-dom + canvas + resvg cold start +
// node_modules linking can take ~10-15s on slow machines, so leave generous
// headroom — the hook is only invoked once per session start, so this isn't
// on a hot path). Overridable via WHITEBOARD_DEV_READY_TIMEOUT_MS, mainly so
// tests can exercise the timeout path without waiting 30s.
const READY_TIMEOUT_MS = resolveReadyTimeoutMs(process.env)
const READY_POLL_INTERVAL_MS = 200
// The token this checkout's clients (the stdio proxy) send. Set
// WHITEBOARD_TOKEN in the shell to use a custom token; when a custom value is
// set the spawned daemon receives an explicit --token flag that overrides the
// default baked into the pnpm script, keeping the two in sync.
const DEV_BEARER_TOKEN = resolveDevBearerToken(process.env)
const LOG_DIR = join(REPO_ROOT, 'tmp', 'logs')
const LOG_PATH = join(LOG_DIR, 'mcp-http-dev.log')
const QUIET = flags.has('--quiet')

function info(message) {
  if (!QUIET) console.log(message)
}

// Returns a verdict instead of acting on it, so the same assessment can run
// twice: once unlocked (the fast path — "is our daemon already up?") and once
// again under the spawn lock (the decisive assessment a winner makes right
// before choosing to spawn). Neither pass ever mutates state.
//
// A record whose daemon is not running is what a daemon that died without
// cleaning up leaves behind, so it reads as no daemon at all.
async function assessDaemon() {
  const record = readDaemonRecord(EXPECTED_DATA_DIR)
  if (record === null) return { kind: 'free' }
  const daemon = await assessRecordedDaemon(record, { answers: answersPing })
  if (!daemon.running) return { kind: 'free' }
  // The ping is unauthenticated. A daemon started with another token (say,
  // `whiteboard daemon start` against this data dir) would refuse every
  // request the clients send, which is worth saying here rather than there.
  if (record.token !== DEV_BEARER_TOKEN) {
    return {
      kind: 'conflict',
      message: describeTokenConflict({ pid: record.pid, dataDir: EXPECTED_DATA_DIR }),
    }
  }
  if (!daemon.answering) {
    return {
      kind: 'busy',
      message: `daemon pid ${record.pid} is running but did not answer its socket within ${PING_TIMEOUT_MS}ms`,
    }
  }
  return { kind: 'healthy', message: `daemon pid ${record.pid} already answering on its socket` }
}

// UNLOCKED fast path. When the daemon is already up, exit without ever
// touching the lock — this is the common case on every session start after
// the first, and it must stay a pure read: no lock file created, no state
// left behind.
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

function failReadyTimeout() {
  console.error(
    `[ensure-http-dev-daemon] timed out waiting for the dev daemon to answer on its socket after ${READY_TIMEOUT_MS}ms — see ${LOG_PATH}. ` +
      'MCP tools will be unavailable for this session.',
  )
  process.exit(1)
}

async function failSpawnedExit(how, logOffset) {
  const log = await readFile(LOG_PATH).catch(() => Buffer.alloc(0))
  const why = refusalLine(log.subarray(logOffset).toString('utf8'))
  console.error(
    `[ensure-http-dev-daemon] the dev server exited (${how}) before its daemon answered${why === null ? '' : `: ${why}`} — full log: ${LOG_PATH}. ` +
      'MCP tools will be unavailable for this session.',
  )
  process.exit(1)
}

// The record's daemon is running, so starting another would only be refused:
// wait for it to answer instead, within the same budget.
async function waitForRunningDaemon(busyMessage) {
  const ready = await waitForDaemon({
    isUp: async () => (await assessDaemon()).kind === 'healthy',
    sleep,
    timeoutMs: READY_TIMEOUT_MS,
    pollIntervalMs: READY_POLL_INTERVAL_MS,
  })
  if (ready) {
    info('[ensure-http-dev-daemon] the running dev daemon answered')
    process.exit(0)
  }
  console.error(
    `[ensure-http-dev-daemon] ${busyMessage}, and still had not after ${READY_TIMEOUT_MS}ms; no second daemon was started. ` +
      'MCP tools will be unavailable for this session — `pnpm mcp:http:stop` and reopen the session to restart it.',
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
  if (assessment.kind === 'busy') {
    await waitForRunningDaemon(assessment.message)
    return
  }

  await mkdir(LOG_DIR, { recursive: true })
  const logFile = await open(LOG_PATH, 'a')
  const logOffset = (await logFile.stat()).size
  const pnpmCmd = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

  const child = spawn(pnpmCmd, buildMcpHttpDevSpawnArgs(DEV_BEARER_TOKEN), {
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

  // Wait for the daemon to actually answer before letting the hook return.
  // Without this, an MCP client started right after the hook can race the
  // daemon's startup while the script reports success. An exit of 0 is the
  // dev server handing over to a daemon that came up in the meantime, which
  // the wait then finds; any other exit is a refusal, and nothing will answer
  // however long this waits.
  let failedExit = null
  child.once('exit', (code, signal) => {
    if (code !== 0) failedExit = signal ?? `code ${code}`
  })
  const ready = await waitForDaemon({
    isUp: async () => (await assessDaemon()).kind === 'healthy',
    sleep,
    timeoutMs: READY_TIMEOUT_MS,
    pollIntervalMs: READY_POLL_INTERVAL_MS,
    gaveUp: () => failedExit !== null,
  })
  if (!ready && failedExit !== null) await failSpawnedExit(failedExit, logOffset)
  if (!ready) failReadyTimeout()

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
// for the daemon to answer — the same wait the winner does — instead of
// exiting immediately. On each poll it also retries acquisition: if the
// holder died before spawning (a dead recorded pid makes its lock
// immediately stale), this process promotes itself to winner and finishes
// the job itself rather than the developer's session staying stuck behind
// a corpse.
async function runAsLoser() {
  const startedAt = Date.now()
  while (Date.now() - startedAt < READY_TIMEOUT_MS) {
    if ((await assessDaemon()).kind === 'healthy') {
      info(
        "[ensure-http-dev-daemon] the dev daemon came up while waiting for another process's spawn",
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
