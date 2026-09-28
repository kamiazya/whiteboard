import { spawn } from 'node:child_process'
import { mkdirSync, openSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'
import { nanoid } from 'nanoid'
import { DATA_DIR, WHITEBOARD_ROOT } from '../shared/data-dir-secure.js'
import { parseOptionalMilliseconds } from '../shared/env-setting.js'
import { withDaemonStartupLock } from './daemon-lock.js'
import {
  type DaemonRecord,
  deleteDaemonRecord,
  isPidAlive,
  loadDaemonRecord,
} from './daemon-registry.js'
import { purgeOldDaemonLogs } from './log-rotation.js'

// Send daemon stdout/stderr to a log file. Using `stdio: 'ignore'` makes
// post-crash debugging much harder.
// Logs rotate daily as `daemon-YYYY-MM-DD.log`, and append mode is safe even
// when multiple daemon startups race on the same host. Old daemon-*.log
// files (older than DEFAULT_DAEMON_LOG_RETAIN_DAYS) are dropped
// fire-and-forget so daemon-startup latency does not include filesystem
// walk time; failure is silent because rotation must never block startup.
function openDaemonLogFile(dataDir: string): number | null {
  try {
    const logsDir = join(dataDir, 'logs')
    mkdirSync(logsDir, { recursive: true, mode: 0o700 })
    const date = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
    const logPath = join(logsDir, `daemon-${date}.log`)
    const fd = openSync(logPath, 'a', 0o600)
    void purgeOldDaemonLogs(dataDir).catch(() => {})
    return fd
  } catch {
    // Logging is best-effort; daemon startup should continue on failure.
    return null
  }
}

export interface EnsureDaemonOptions {
  dataDir?: string
  env?: NodeJS.ProcessEnv
  idleTimeoutMs?: number
  startupTimeoutMs?: number
}

interface SpawnArgs {
  command: string
  args: string[]
}

// The token is deliberately NOT a parameter here: it travels in the spawned
// process's ENVIRONMENT (WHITEBOARD_TOKEN, read by server/index.ts's
// resolveToken), never on argv. On Linux /proc/<pid>/cmdline is world-readable
// by default while /proc/<pid>/environ is 0400 owner-only, and argv also
// reaches every `ps aux`, monitoring agent, and pasted bug report — so a
// full-authority bearer credential on the command line is strictly worse than
// the 0600 daemon.json it is written to moments later.
function buildDaemonSpawnArgs(options: {
  env: NodeJS.ProcessEnv
  idleTimeoutMs: number
}): SpawnArgs {
  const { env, idleTimeoutMs } = options
  const baseArgs = [`--idle-timeout-ms=${idleTimeoutMs}`]

  if (env.WHITEBOARD_DEV === '1') {
    const nodeArgs =
      env.WHITEBOARD_NO_WATCH === '1' ? ['--import', 'tsx/esm'] : ['--watch', '--import', 'tsx/esm']
    return {
      command: 'node',
      args: [...nodeArgs, join(WHITEBOARD_ROOT, 'src/server/daemon-entry.ts'), ...baseArgs],
    }
  }

  return {
    command: 'node',
    args: [join(WHITEBOARD_ROOT, 'dist/server/daemon-entry.js'), ...baseArgs],
  }
}

/** ADR-0050 decision 2: the daemon answers only on the socket its record names. */
function pingDaemonSocket(socketPath: string): Promise<boolean> {
  return new Promise((resolvePing) => {
    const req = request({ socketPath, path: '/api/runtime/ping' }, (res) => {
      res.resume()
      resolvePing(res.statusCode === 200)
    })
    req.on('error', () => resolvePing(false))
    req.end()
  })
}

async function answeringRecord(dataDir: string): Promise<DaemonRecord | null> {
  const record = await loadDaemonRecord(dataDir)
  if (record === null || !isPidAlive(record.pid)) return null
  return (await pingDaemonSocket(record.socketPath)) ? record : null
}

const DAEMON_STARTUP_TIMEOUT_ENV = 'WHITEBOARD_DAEMON_STARTUP_TIMEOUT_MS'

// Packaged daemon cold-start (native modules, WASM, first-run migrations) can
// exceed the 10s default on slow CI runners. WHITEBOARD_DAEMON_STARTUP_TIMEOUT_MS
// lets such environments wait longer; an explicit option always wins.
//
// A value that is present and unusable THROWS rather than falling back, per
// `shared/env-setting.ts`: whoever set it had a slow environment in mind, and
// silently waiting the default 10s instead answers that with the very failure
// they were trying to avoid — and the timeout that follows names the daemon,
// not the setting, so nothing points at the real cause. `ensureDaemon`
// already throws on an unusable `startPort`, so this is the same shape.
//
// Zero is an error here rather than a meaning. Unlike the GC sweeps, where 0
// disables the pass, a zero timeout would mean "give up before looking",
// which nobody wants and which used to silently become 10s.
export function resolveStartupTimeoutMs(env: NodeJS.ProcessEnv, override?: number): number {
  if (override !== undefined) return override
  const parsed = parseOptionalMilliseconds(env[DAEMON_STARTUP_TIMEOUT_ENV], null)
  if (!parsed.ok) {
    // The value is not echoed, matching how every other setting reports.
    throw new Error(`${DAEMON_STARTUP_TIMEOUT_ENV} ${parsed.reason}`)
  }
  if (parsed.value === null) return 10_000
  if (parsed.value === 0) {
    throw new Error(`${DAEMON_STARTUP_TIMEOUT_ENV} must be greater than zero`)
  }
  return parsed.value
}

/** Waits for the spawned daemon to write its record and answer on the socket it names. */
async function waitForDaemon(dataDir: string, timeoutMs: number): Promise<DaemonRecord> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const record = await answeringRecord(dataDir)
    if (record !== null) return record
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Daemon startup timeout')
}

export async function ensureDaemon(options: EnsureDaemonOptions = {}): Promise<DaemonRecord> {
  const dataDir = options.dataDir ?? DATA_DIR
  const env = options.env ?? process.env
  const idleTimeoutMs = options.idleTimeoutMs ?? 15 * 60_000
  const startupTimeoutMs = resolveStartupTimeoutMs(env, options.startupTimeoutMs)

  const existing = await answeringRecord(dataDir)
  if (existing !== null) return existing

  return withDaemonStartupLock(
    dataDir,
    async () => {
      const fresh = await answeringRecord(dataDir)
      if (fresh !== null) return fresh

      await deleteDaemonRecord(dataDir)

      const token = nanoid(32)
      const { command, args } = buildDaemonSpawnArgs({ env, idleTimeoutMs })
      // Send stdout/stderr to ~/.whiteboard/logs/daemon-YYYY-MM-DD.log.
      // If opening the file fails, fall back to 'ignore' without blocking startup.
      const logFd = openDaemonLogFile(dataDir)
      const child = spawn(command, args, {
        cwd: WHITEBOARD_ROOT,
        env: {
          ...env,
          WHITEBOARD_DATA_DIR: dataDir,
          // Set LAST, so it overrides any ambient WHITEBOARD_TOKEN: the daemon
          // must come up holding the token this call generated, since that is
          // the one the record and every caller derived from it will carry.
          WHITEBOARD_TOKEN: token,
        },
        detached: true,
        stdio: logFd !== null ? ['ignore', logFd, logFd] : 'ignore',
      })
      child.unref()

      return await waitForDaemon(dataDir, startupTimeoutMs)
    },
    { timeoutMs: startupTimeoutMs },
  )
}
