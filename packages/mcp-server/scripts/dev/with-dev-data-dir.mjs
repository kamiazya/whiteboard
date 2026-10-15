#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  assessRecordedDaemon,
  BUILT_LAUNCH,
  isPidAlive,
  isPidFileWriter,
  readDaemonRecord,
} from './dev-daemon-socket-lib.mjs'
import {
  acquireSpawnLock,
  claimPidFile,
  releasePidFile,
  releaseSpawnLock,
  resolveSpawnLockStaleMs,
} from './dev-spawn-lock-lib.mjs'
import { resolveReadyTimeoutMs, waitForDaemon } from './ensure-http-dev-daemon-lib.mjs'
import {
  devSpawnLockPath,
  devWrapperPidPath,
  ensureDevDataDirSecured,
  resolveDevDataDirEnv,
  resolveRepoRootFromGit,
  resolveTsxWatchSpawn,
  superviseChild,
} from './with-dev-data-dir-lib.mjs'

// Keeps dev daemons started via `pnpm mcp:http:dev` (and anything that
// shells out to it — mcp:debug:http, the SessionStart ensure-http-dev-daemon
// hook) out of the real ~/.whiteboard by default. A node wrapper (not a
// shell `VAR=x` prefix in package.json) so this stays correct on Windows.
const repoRoot = resolveRepoRootFromGit(process.cwd())
const packageRoot = resolve(repoRoot, 'packages/mcp-server')
const hadExplicitDataDirOverride = Boolean(process.env.WHITEBOARD_DATA_DIR)
const env = resolveDevDataDirEnv(process.env, repoRoot)
const LOCK_POLL_MS = 100

// resolveDataDir() (shared/data-dir-secure.ts) only hardens permissions on
// its own home-directory default; an explicit WHITEBOARD_DATA_DIR — which is
// exactly what we just set below — short-circuits that and skips it
// entirely. Harden it ourselves, but only for the repo-local default we
// injected: a caller-provided override is respected as-is, same contract as
// resolveDataDir().
if (!hadExplicitDataDirOverride) {
  ensureDevDataDirSecured(env.WHITEBOARD_DATA_DIR)
}

// Decided here, before a watcher exists: a second daemon cannot take the
// socket anyway, and a wrapper started beside a running one would replace the
// pid file `pnpm mcp:http:stop` signals and then sit under `tsx watch` holding
// nothing. A running daemon is handed over to rather than refused, so `pnpm dev`
// and `pnpm mcp:debug:http` keep their other half beside the SessionStart
// hook's daemon. "Running" is the one predicate the hook and the stop share.
async function handOverIfRunning() {
  const running = readDaemonRecord(env.WHITEBOARD_DATA_DIR)
  const daemon = running === null ? null : await assessRecordedDaemon(running)
  if (running === null || !daemon?.running) return
  const answering = daemon.answering ? '' : ' (busy: it did not answer its socket just now)'
  // Still exit 0 for a built daemon: `pnpm dev` runs this under
  // `concurrently --kill-others-on-fail`, and a refusal would take Vite down.
  // What it must not do is call a build the dev daemon, since a source edit
  // will never reach that process.
  console.error(
    running.launch === BUILT_LAUNCH
      ? `[with-dev-data-dir] the BUILT daemon (pid ${running.pid}, running a build, not this checkout's source) is running for ${env.WHITEBOARD_DATA_DIR}${answering}; ` +
          'source edits will not reload it — to run the watch-mode dev daemon instead, `pnpm mcp:http:stop` first.'
      : `[with-dev-data-dir] reusing the dev daemon already running for ${env.WHITEBOARD_DATA_DIR} (pid ${running.pid})${answering} — ` +
          'to run one in this terminal instead, `pnpm mcp:http:stop` first.',
  )
  exitReleasingLock(0)
}

// A daemon writes its record only once it listens, so the check above cannot
// see one that is still booting: two starts inside that window would each run
// a watcher, and the loser's `tsx watch` would outlive its refused daemon. The
// SessionStart hook's spawn lock is therefore held from the check until the
// record appears or the child exits. The hook starts this wrapper as its direct
// child while holding that lock, so a lock held by the parent is this start's
// own.
const lockPath = devSpawnLockPath(env.WHITEBOARD_DATA_DIR)
let ownsLock = false
let lockHolderPid = null
function releaseLock() {
  if (ownsLock) releaseSpawnLock({ lockPath, ownerPid: process.pid })
  ownsLock = false
}
function exitReleasingLock(code) {
  releaseLock()
  process.exit(code)
}
function tryLock() {
  const claim = acquireSpawnLock({
    lockPath,
    meta: { pid: process.pid, startedAt: new Date().toISOString(), repoRoot },
    staleAfterMs: resolveSpawnLockStaleMs(process.env),
    isPidAlive,
  })
  if (claim.kind === 'acquired') {
    ownsLock = true
    return true
  }
  lockHolderPid = claim.holderPid
  return lockHolderPid === process.ppid
}

await handOverIfRunning()
if (!tryLock()) {
  console.error(
    `[with-dev-data-dir] another dev daemon is starting for ${env.WHITEBOARD_DATA_DIR} (pid ${lockHolderPid} holds ${lockPath}); waiting for it to come up.`,
  )
  const waitMs = resolveReadyTimeoutMs(process.env)
  const startedAt = Date.now()
  for (;;) {
    await handOverIfRunning()
    if (tryLock()) break
    if (Date.now() - startedAt >= waitMs) {
      console.error(
        `[with-dev-data-dir] another dev daemon was still starting for ${env.WHITEBOARD_DATA_DIR} after ${waitMs}ms; ` +
          'not starting a second one. `pnpm mcp:http:stop`, then start it again.',
      )
      process.exit(1)
    }
    await sleep(LOCK_POLL_MS)
  }
}
// Decisive pass, under the lock: whoever held it may have brought one up.
await handOverIfRunning()

// `pnpm mcp:http:stop` signals the pid in this file, so it is created
// exclusively: a wrapper still running beside a daemon that is not (one whose
// daemon crashed and is waiting under `tsx watch` for the next edit, say)
// keeps it, and this start refuses rather than run a second watcher.
const pidPath = devWrapperPidPath(env.WHITEBOARD_DATA_DIR)
mkdirSync(dirname(pidPath), { recursive: true })
const pidFile = claimPidFile({
  pidPath,
  pid: process.pid,
  isWriterAlive: (pid, writtenAtMs) => isPidFileWriter(pid, writtenAtMs),
})
if (pidFile.kind === 'held') {
  console.error(
    `[with-dev-data-dir] a dev wrapper (pid ${pidFile.pid}) is already running for ${env.WHITEBOARD_DATA_DIR}; ` +
      'not starting a second watcher. `pnpm mcp:http:stop` to stop it first.',
  )
  exitReleasingLock(1)
}

// Shell out to the real tsx CLI (not node's --watch + --import loader) so
// this matches the exact restart/reload behavior of the pre-existing
// `tsx watch ...` package script. Spawns node directly against tsx's
// dist/cli.mjs rather than node_modules/.bin/tsx: that .bin entry is a POSIX
// shell shim (with separate .cmd/.ps1 wrappers on Windows), which `shell:
// false` cannot execute on native Windows.

const entryPath = resolve(packageRoot, 'src/server/daemon-entry.ts')
const { command, args } = resolveTsxWatchSpawn(packageRoot, entryPath, process.argv.slice(2))

const child = spawn(command, args, {
  cwd: packageRoot,
  env,
  stdio: 'inherit',
})

// Removed on every way out of the wrapper, so a stale file cannot name a pid
// something else has since taken — but only while it still names this wrapper.
superviseChild(child, {
  cleanup: () => {
    releaseLock()
    releasePidFile({ pidPath, pid: process.pid })
  },
})

// The boot window ends when the daemon's record says it is running; a daemon
// that never gets there (a syntax error waiting on the next edit) frees the
// lock after the hook's ready budget, and the pid file still keeps a second
// watcher out.
if (ownsLock) {
  await waitForDaemon({
    // The daemon is `tsx watch`'s child, this wrapper's grandchild, so its pid
    // is unknowable here: booted means some recorded daemon is running.
    isUp: async () => {
      const record = readDaemonRecord(env.WHITEBOARD_DATA_DIR)
      return record !== null && (await assessRecordedDaemon(record)).running
    },
    gaveUp: () => !ownsLock,
    sleep,
    timeoutMs: resolveReadyTimeoutMs(process.env),
    pollIntervalMs: LOCK_POLL_MS,
  })
  releaseLock()
}
