import { spawn } from 'node:child_process'
import { mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { nanoid } from 'nanoid'
import { DATA_DIR, WHITEBOARD_ROOT } from '../shared/data-dir-secure.js'
import { parseOptionalMilliseconds } from '../shared/env-setting.js'
import { PACKAGE_VERSION } from '../shared/package-version.js'
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

export interface EnsureDaemonResult extends DaemonRecord {
  baseUrl: string
}

export interface EnsureDaemonOptions {
  dataDir?: string
  env?: NodeJS.ProcessEnv
  host?: string
  idleTimeoutMs?: number
  startupTimeoutMs?: number
  startPort?: number
}

interface SpawnArgs {
  command: string
  args: string[]
}

async function findAvailablePort(start = 3099): Promise<number> {
  const { createServer } = await import('node:net')
  return new Promise((resolve, reject) => {
    if (start < 0 || start > 65535) {
      reject(new Error(`No available TCP port found starting from 3099`))
      return
    }
    const server = createServer()
    server.listen(start, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate port')))
        return
      }
      server.close(() => resolve(address.port))
    })
    server.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        void findAvailablePort(start + 1)
          .then(resolve)
          .catch(reject)
        return
      }
      reject(
        new Error(
          `Failed to bind daemon port ${start} on 127.0.0.1 (${error.code ?? 'unknown error'}: ${error.message})`,
        ),
      )
    })
  })
}

function buildDaemonSpawnArgs(options: {
  env: NodeJS.ProcessEnv
  port: number
  token: string
  host: string
  idleTimeoutMs: number
}): SpawnArgs {
  const { env, port, token, host, idleTimeoutMs } = options
  const baseArgs = [
    '--daemon',
    `--port=${port}`,
    `--token=${token}`,
    `--host=${host}`,
    `--idle-timeout-ms=${idleTimeoutMs}`,
  ]

  if (env.WHITEBOARD_DEV === '1') {
    const nodeArgs =
      env.WHITEBOARD_NO_WATCH === '1' ? ['--import', 'tsx/esm'] : ['--watch', '--import', 'tsx/esm']
    return {
      command: 'node',
      args: [...nodeArgs, join(WHITEBOARD_ROOT, 'src/server/index.ts'), ...baseArgs],
    }
  }

  return {
    command: 'node',
    args: [join(WHITEBOARD_ROOT, 'dist/server/index.js'), ...baseArgs],
  }
}

async function pingDaemon(port: number, host: string): Promise<boolean> {
  try {
    const res = await fetch(`http://${host}:${port}/api/runtime/ping`)
    return res.ok
  } catch {
    return false
  }
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

async function waitForDaemon(port: number, host: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await pingDaemon(port, host)) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Daemon startup timeout')
}

export async function ensureDaemon(options: EnsureDaemonOptions = {}): Promise<EnsureDaemonResult> {
  const dataDir = options.dataDir ?? DATA_DIR
  const env = options.env ?? process.env
  const host = options.host ?? '127.0.0.1'
  const idleTimeoutMs = options.idleTimeoutMs ?? 15 * 60_000
  const startupTimeoutMs = resolveStartupTimeoutMs(env, options.startupTimeoutMs)
  if (
    options.startPort !== undefined &&
    (!Number.isInteger(options.startPort) || options.startPort < 0 || options.startPort > 65535)
  ) {
    throw new Error(`Invalid daemon startPort: ${options.startPort}`)
  }
  const existing = await loadDaemonRecord(dataDir)

  if (existing && isPidAlive(existing.pid) && (await pingDaemon(existing.port, host))) {
    return {
      ...existing,
      baseUrl: `http://${host}:${existing.port}`,
    }
  }

  return withDaemonStartupLock(
    dataDir,
    async () => {
      const fresh = await loadDaemonRecord(dataDir)
      if (fresh && isPidAlive(fresh.pid) && (await pingDaemon(fresh.port, host))) {
        return {
          ...fresh,
          baseUrl: `http://${host}:${fresh.port}`,
        }
      }

      await deleteDaemonRecord(dataDir)

      const port = options.startPort ?? (await findAvailablePort(3099))
      const token = nanoid(32)
      const { command, args } = buildDaemonSpawnArgs({
        env,
        port,
        token,
        host,
        idleTimeoutMs,
      })
      // Send stdout/stderr to ~/.whiteboard/logs/daemon-YYYY-MM-DD.log.
      // If opening the file fails, fall back to 'ignore' without blocking startup.
      const logFd = openDaemonLogFile(dataDir)
      const child = spawn(command, args, {
        cwd: WHITEBOARD_ROOT,
        env: {
          ...env,
          WHITEBOARD_DATA_DIR: dataDir,
        },
        detached: true,
        stdio: logFd !== null ? ['ignore', logFd, logFd] : 'ignore',
      })
      child.unref()

      await waitForDaemon(port, host, startupTimeoutMs)

      const record = await loadDaemonRecord(dataDir)
      if (record && record.port === port) {
        return {
          ...record,
          baseUrl: `http://${host}:${record.port}`,
        }
      }

      return {
        pid: child.pid ?? -1,
        port,
        token,
        version: env.npm_package_version ?? PACKAGE_VERSION,
        startedAt: new Date().toISOString(),
        baseUrl: `http://${host}:${port}`,
      }
    },
    { timeoutMs: startupTimeoutMs },
  )
}
