#!/usr/bin/env node
import { spawn } from 'node:child_process'
// The BUILT-artifact variant of `pnpm mcp:http:dev`: runs dist/ instead of
// watch-mode source, for checking the daemon as it ships. Without
// `pnpm build` first the bare `node dist/...` fails with a MODULE_NOT_FOUND
// that names no cause, so the prerequisite is checked and said out loud.
//
// Built or not, it is a DEV daemon, so it keeps the checkout's `.dev-data`
// exactly as `mcp:http:dev` does — the installed release's `~/.whiteboard`
// is no place for a build of unreleased migrations.
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import {
  assessRecordedDaemon,
  isPidAlive,
  isPidFileWriter,
  readDaemonRecord,
} from './dev-daemon-socket-lib.mjs'
import {
  acquireSpawnLock,
  readPidFile,
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
} from './with-dev-data-dir-lib.mjs'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')
const entry = join(packageRoot, 'dist/server/daemon-entry.js')
if (!existsSync(entry)) {
  process.stderr.write(
    '[mcp:http] dist/server/daemon-entry.js is missing — this script runs the BUILT daemon; run `pnpm build` first (or use `pnpm mcp:http:dev` for watch-mode source).\n',
  )
  process.exit(1)
}

// A build older than the source is refused by name. The source dev daemon
// migrates `.dev-data` to the newest migration, and a build without it then
// stops with an "upgrade to the latest release" error — while the release may
// not ship that migration yet either. The newest name is the one to check:
// kysely runs migrations in name order, so it is the last one any build gains.
const registry = join(packageRoot, 'src/server/store/db/migrations/index.ts')
if (existsSync(registry)) {
  const names = [...readFileSync(registry, 'utf8').matchAll(/'(\d{4}-[a-z0-9-]+)':/g)].map(
    (m) => m[1],
  )
  const newest = names.toSorted().at(-1)
  if (newest && !builtFilesShip(join(packageRoot, 'dist'), newest)) {
    process.stderr.write(
      `[mcp:http] dist/ is older than this checkout's source: it does not ship migration ${newest}. Run \`pnpm build\` first (or use \`pnpm mcp:http:dev\` for watch-mode source).\n`,
    )
    process.exit(1)
  }
}

/** Whether any built `.js` under `dir` names `text`; the served web app and widget are not the server. */
function builtFilesShip(dir, text) {
  return readdirSync(dir, { withFileTypes: true, recursive: true }).some((entry) => {
    const path = join(entry.parentPath, entry.name)
    return (
      entry.isFile() &&
      entry.name.endsWith('.js') &&
      !/^(web-app|widget)[\\/]/.test(relative(dir, path)) &&
      readFileSync(path, 'utf8').includes(text)
    )
  })
}

const hadExplicitDataDirOverride = Boolean(process.env.WHITEBOARD_DATA_DIR)
const env = resolveDevDataDirEnv(process.env, resolveRepoRootFromGit(packageRoot))
if (!hadExplicitDataDirOverride) ensureDevDataDirSecured(env.WHITEBOARD_DATA_DIR)
const dataDir = env.WHITEBOARD_DATA_DIR
mkdirSync(dataDir, { recursive: true })

// The SessionStart hook keeps a source dev daemon on this same data dir. A
// second daemon cannot take its socket — and one starting inside the other's
// boot window fails its migrations instead, reading like a corrupt store — so
// both cases are refused by name before spawning. Refused, not handed over to:
// the caller asked for the BUILT artifact, and reusing watch-mode source would
// silently check the wrong one. The spawn lock is the hook's and the wrapper's,
// held from this check until the record appears, as theirs is.
const lockPath = devSpawnLockPath(dataDir)
const lock = acquireSpawnLock({
  lockPath,
  meta: { pid: process.pid, startedAt: new Date().toISOString() },
  staleAfterMs: resolveSpawnLockStaleMs(process.env),
  isPidAlive,
})
if (lock.kind === 'held') {
  refuse(`another dev daemon is starting for ${dataDir} (pid ${lock.holderPid} holds ${lockPath})`)
}
const running = readDaemonRecord(dataDir)
if (running !== null && (await assessRecordedDaemon(running)).running) {
  refuse(`the dev daemon (pid ${running.pid}) is running for ${dataDir}`)
}
// A dev daemon that crashed under `tsx watch` has removed its record while its
// wrapper waits for the next source edit, which restarts it into this socket.
const wrapper = readPidFile(devWrapperPidPath(dataDir))
if (wrapper !== null && isPidFileWriter(wrapper.pid, wrapper.writtenAtMs)) {
  refuse(
    `a dev wrapper (pid ${wrapper.pid}) is running for ${dataDir} (its daemon is down, waiting for a source edit)`,
  )
}

const child = spawn(process.execPath, [entry, '--token=whiteboard-dev'], { stdio: 'inherit', env })
let childExited = false
child.on('exit', (code) => {
  childExited = true
  releaseLock()
  process.exit(code ?? 1)
})

await waitForDaemon({
  // The daemon is this script's direct child and writes its record only once
  // it listens, so booted means the record names that child.
  isUp: () => readDaemonRecord(dataDir)?.pid === child.pid,
  gaveUp: () => childExited,
  sleep,
  timeoutMs: resolveReadyTimeoutMs(process.env),
  pollIntervalMs: 200,
})
releaseLock()

function releaseLock() {
  releaseSpawnLock({ lockPath, ownerPid: process.pid })
}

function refuse(reason) {
  releaseLock()
  process.stderr.write(
    `[mcp:http] ${reason}; not starting the built daemon beside it. \`pnpm mcp:http:stop\` first.\n`,
  )
  process.exit(1)
}
