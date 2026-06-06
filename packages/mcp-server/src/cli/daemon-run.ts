// `whiteboard daemon run --json` business logic.
//
// Starts the HTTP server in-process, writes the daemon record, emits the ready
// JSON, and installs SIGTERM/SIGINT handlers that close the server and remove
// the record before exiting. The dispatcher keeps the process alive with its
// own never-resolving promise after calling this function.

import { createServer } from 'node:net'
import { nanoid } from 'nanoid'
import { withDaemonStartupLock } from '../daemon/daemon-lock.js'
import {
  deleteDaemonRecord,
  isPidAlive,
  loadDaemonRecord,
  saveDaemonRecord,
} from '../daemon/daemon-registry.js'
import { DATA_DIR } from '../shared/data-dir-secure.js'
import { startHttpServer } from '../server/http-server.js'
import { PACKAGE_VERSION } from '../shared/package-version.js'

const DAEMON_RUN_SCHEMA_VERSION = 1 as const

export interface DaemonRunReadyResult {
  readonly schemaVersion: typeof DAEMON_RUN_SCHEMA_VERSION
  readonly ok: true
  readonly pid: number
  readonly port: number
  readonly host: string
  readonly version: string
  readonly startedAt: string
}

export type DaemonRunOutcome =
  | { kind: 'input-error'; message: string }
  | { kind: 'refused'; message: string }
  | { kind: 'running'; result: DaemonRunReadyResult }

export interface DaemonRunOptions {
  host?: string
  port?: number
  dataDir?: string
  tokenStdin: boolean
}

// Exported for unit testing of the EADDRINUSE-only retry contract.
export async function findAvailablePort(start = 3099): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(start, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : start
      server.close(() => resolve(port))
    })
    server.on('error', (error: NodeJS.ErrnoException) => {
      // Only retry the next port when this one is in use. Any other error (EACCES,
      // EADDRNOTAVAIL, …) is permanent for this scan and must reject immediately
      // instead of walking ~62k ports and hiding the real cause behind a generic message.
      if (error.code !== 'EADDRINUSE') {
        reject(error)
        return
      }
      if (start >= 65535) {
        reject(new Error('No available TCP port found'))
        return
      }
      findAvailablePort(start + 1).then(resolve, reject)
    })
  })
}

async function readTokenFromStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      buf += chunk
    })
    process.stdin.on('end', () => resolve(buf.trim()))
    process.stdin.on('error', reject)
  })
}

function installDaemonSignalHandlers(cleanup: () => Promise<void>): void {
  const handle = () => {
    void cleanup().finally(() => process.exit(0))
  }
  process.once('SIGTERM', handle)
  process.once('SIGINT', handle)
}

export async function runDaemonRun(options: DaemonRunOptions): Promise<DaemonRunOutcome> {
  const dataDir = options.dataDir ?? DATA_DIR

  const existing = await loadDaemonRecord(dataDir)
  if (existing !== null && isPidAlive(existing.pid)) {
    return {
      kind: 'refused',
      message: 'A daemon is already running. Stop it first with: whiteboard daemon stop --json',
    }
  }

  let token: string
  if (options.tokenStdin) {
    try {
      token = await readTokenFromStdin()
    } catch {
      return { kind: 'input-error', message: 'Failed to read token from stdin.' }
    }
    if (!token) {
      return { kind: 'input-error', message: 'Token read from stdin was empty.' }
    }
  } else {
    token = process.env.WHITEBOARD_DAEMON_TOKEN ?? nanoid(32)
  }

  return await withDaemonStartupLock(dataDir, async () => {
    const port = options.port ?? (await findAvailablePort())
    const host = options.host ?? '127.0.0.1'

    const running = await startHttpServer({ port, host, token })

    const startedAt = new Date().toISOString()

    await saveDaemonRecord(
      {
        pid: process.pid,
        port: running.port,
        token,
        version: PACKAGE_VERSION,
        startedAt,
      },
      dataDir,
    )

    installDaemonSignalHandlers(async () => {
      await running.close()
      await deleteDaemonRecord(dataDir)
    })

    return {
      kind: 'running' as const,
      result: {
        schemaVersion: DAEMON_RUN_SCHEMA_VERSION,
        ok: true,
        pid: process.pid,
        port: running.port,
        host,
        version: PACKAGE_VERSION,
        startedAt,
      },
    }
  })
}
