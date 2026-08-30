// HTTP server startup for server-mode (OAuth/JWT, no local-daemon lifecycle).
//
// Server-mode does not use WebSocket, idle timeout, or per-connection
// tracking in this initial slice — those are local-daemon concerns.
// The close() returned by startServerModeHttp tears down the HTTP server
// cleanly so the dispatcher's SIGTERM handler can await it.

import { randomUUID } from 'node:crypto'
import { accessSync, constants as fsConstants } from 'node:fs'
import { serve } from '@hono/node-server'
import { PACKAGE_VERSION } from '../shared/package-version.js'
import { createApp } from './app.js'
import { startBackgroundWork } from './background-work.js'
import { getDataDir } from './config.js'
import type { AsyncAuthStrategy } from './security/oauth-resource-strategy.js'
import { createBackupLease, createBackupScheduler } from './store/backup-scheduler.js'
import { createFileGcSweeper } from './store/file-gc-sweeper.js'
import { parseBackupDir, parseBackupKeep, parseBackupSchedule } from './store/storage-env.js'

export interface StartServerModeHttpOptions {
  host: string
  port: number
  publicBaseUrl: string
  allowedOrigins: readonly string[]
  authStrategy: AsyncAuthStrategy
  /** Test-only seam, matching `startHttpServer`'s: overrides the real
   *  factory so a wiring test can assert the sweeper is armed and stopped
   *  without running a full pass. */
  fileGcSweeperFactory?: typeof createFileGcSweeper
}

// Caps how long close() waits for an in-flight file-gc pass. Same value and
// same reason as the local daemon's: a full pass can be expensive, and a
// shutdown that appears to hang is worse than one that leaves a pass to
// finish in the background.
const FILE_GC_STOP_TIMEOUT_MS = 5_000

export interface ServerModeRunning {
  port: number
  host: string
  startedAt: string
  resolvedDataDir: string
  /** Unique per process-start id; written into the server-mode record so
   *  stop/status/doctor can verify identity instead of trusting a reused pid. */
  instanceId: string
  close: () => Promise<void>
}

function isDataDirWritable(dir: string): boolean {
  try {
    accessSync(dir, fsConstants.W_OK)
    return true
  } catch {
    return false
  }
}

export async function startServerModeHttp(
  options: StartServerModeHttpOptions,
): Promise<ServerModeRunning> {
  const startedAtMs = Date.now()
  const startedAt = new Date(startedAtMs).toISOString()
  const instanceId = randomUUID()
  const baseUrl = `https://${options.host}:${options.port}`
  let closing = false

  const close = async () => {
    if (closing) return
    closing = true
    await backgroundWork.stopAll()
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  const app = createApp({
    authMode: 'server-mode',
    publicBaseUrl: options.publicBaseUrl,
    allowedOrigins: options.allowedOrigins,
    authStrategy: options.authStrategy,
    instanceId,
    touch: () => {},
    getStatus: () => ({
      ok: true,
      pid: process.pid,
      host: options.host,
      port: options.port,
      baseUrl,
      version: PACKAGE_VERSION,
      startedAt,
      uptimeMs: Date.now() - startedAtMs,
      idleForMs: 0,
      auth: { mode: 'oauth', hasToken: false },
      storage: {
        dataDir: getDataDir(),
        dataDirWritable: isDataDirWritable(getDataDir()),
      },
      app: {
        // The static placeholder page is always available — it ships inline
        // in app.ts, not as a build artifact — so both fields are fixed.
        served: true,
        buildPresent: true,
        ui: 'server-placeholder',
      },
      mcp: { httpEnabled: true, endpoint: `${baseUrl}/mcp` },
      clients: { connected: 0, ready: 0 },
      publicBaseUrl: options.publicBaseUrl,
    }),
    shutdown: close,
  })

  // Server mode is the MULTI-INSTANCE deployment (ADR-0020), so it is the one
  // the backup lease was built for — and until this was wired it was the one
  // deployment taking no scheduled backups at all, because this composition
  // root started no background work whatsoever. The registry is what made
  // that visible: local-daemon declared four workers and this file declared
  // none.
  const fileGcSweeper = (options.fileGcSweeperFactory ?? createFileGcSweeper)()
  const backupDir = parseBackupDir(process.env)
  const backupSchedule = parseBackupSchedule(process.env)
  const backupKeep = parseBackupKeep(process.env)
  const backgroundWork = startBackgroundWork([
    {
      name: 'backup-scheduler',
      trigger: backupSchedule.ok ? backupSchedule.value.expression : '0 3 * * *',
      instances: { runs: 'leader-only', lease: 'backup' },
      loop: {
        runs: 'subprocess',
        because:
          'the snapshot step blocks the event loop for its whole duration — measured 1242ms ' +
          'at a 103MB database and 4767ms at 421MB, growing with the data',
      },
      worker: createBackupScheduler({
        dataDir: getDataDir(),
        backupDir: backupDir.ok ? backupDir.value : null,
        ...(backupSchedule.ok ? { schedule: backupSchedule.value } : {}),
        ...(backupKeep.ok && backupKeep.value !== null ? { keep: backupKeep.value } : {}),
        runExclusively: createBackupLease({ holder: instanceId }),
      }),
    },
    {
      name: 'file-gc-sweeper',
      trigger: 'every WHITEBOARD_FILE_GC_INTERVAL_MS (24h by default); the sweeper resolves it',
      instances: {
        runs: 'every-instance',
        because:
          'ADR-0020 rejects a GC leader: it removes GC-versus-GC races and leaves ' +
          'GC-versus-WRITE untouched, since the write barrier is in-process. Two passes ' +
          'racing the same file is the benign half — the second unlink answers ENOENT and ' +
          'is logged and skipped.',
      },
      loop: {
        runs: 'in-process',
        worstStallMs: 39,
        fixture:
          '6 documents at 8 versions each, by file-gc-loop-availability.test.ts; the same ' +
          'pass without its yields stalled 1342ms unbroken, and 5 documents at 20 versions ' +
          'each stalled 7404ms',
        measuredOn: '2026-08-30',
      },
      worker: {
        start: () => fileGcSweeper.start(),
        stop: () => fileGcSweeper.stop({ timeoutMs: FILE_GC_STOP_TIMEOUT_MS }),
      },
    },
    {
      name: 'workspace-tail',
      trigger: 'not armed here',
      instances: {
        runs: 'every-instance',
        because: 'each instance catches ITS OWN cached documents up with what another wrote',
      },
      loop: {
        runs: 'in-process',
        worstStallMs: 7,
        fixture:
          '10 workspaces with real history, by workspace-tail-loop-availability.test.ts; ' +
          'the same pass without its yield blocked for all 80.1ms of its duration',
        measuredOn: '2026-08-30',
      },
      // Nothing to catch up: server mode has no WebSocket subscribers in this
      // slice, and the tail exists to serve a browser attached to THIS
      // instance. It arms when server mode grows the subscription surface.
      worker: null,
    },
  ])

  const server = serve({ fetch: app.fetch, port: options.port, hostname: options.host })

  await new Promise<void>((resolve, reject) => {
    if ((server as unknown as { listening: boolean }).listening) {
      resolve()
      return
    }
    const onListening = () => {
      server.removeListener('error', onError)
      resolve()
    }
    const onError = (err: Error) => {
      server.removeListener('listening', onListening)
      reject(err)
    }
    server.once('listening', onListening)
    server.once('error', onError)
  })

  return {
    port: options.port,
    host: options.host,
    startedAt,
    resolvedDataDir: getDataDir(),
    instanceId,
    close,
  }
}
