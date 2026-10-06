#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { assessRecordedDaemon, readDaemonRecord } from './dev-daemon-socket-lib.mjs'
import {
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
const running = readDaemonRecord(env.WHITEBOARD_DATA_DIR)
const daemon = running === null ? null : await assessRecordedDaemon(running)
if (running !== null && daemon?.running) {
  const answering = daemon.answering ? '' : ' (busy: it did not answer its socket just now)'
  console.error(
    `[with-dev-data-dir] reusing the dev daemon already running for ${env.WHITEBOARD_DATA_DIR} (pid ${running.pid})${answering} — ` +
      'to run one in this terminal instead, `pnpm mcp:http:stop` first.',
  )
  process.exit(0)
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

// `pnpm mcp:http:stop` signals this pid. Removed on every way out of the
// wrapper, so a stale file cannot name a pid something else has since taken.
const pidPath = devWrapperPidPath(env.WHITEBOARD_DATA_DIR)
mkdirSync(dirname(pidPath), { recursive: true })
writeFileSync(pidPath, String(process.pid), { mode: 0o600 })

superviseChild(child, { cleanup: () => rmSync(pidPath, { force: true }) })
