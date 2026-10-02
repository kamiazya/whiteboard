import { randomUUID } from 'node:crypto'
import type { ReplicaTier } from '@kamiazya/whiteboard-daemon-client/api-contracts/replica-key'
import type { RuntimeStatusResponse } from '@kamiazya/whiteboard-daemon-client/api-contracts/runtime'
import { listenOnSocket } from '../daemon/daemon-socket.js'
import { IdleTimer } from '../daemon/idle-timer.js'
import { bootLocalDeps } from '../di/boot-local-deps.js'
import { PACKAGE_VERSION } from '../shared/package-version.js'
import { createApp } from './app.js'
import { startBackgroundWork } from './background-work.js'
import { LOOP_COSTS } from './background-work-costs.js'
import { attachLiveAudience } from './canvas-client-notifier.js'
import { getDataDir } from './config.js'
import { isDataDirWritable } from './data-dir-writable.js'
import { startHttpRootTracing } from './observability/root-tracing.js'
import { DEFAULT_REPLICA_TIER } from './replica-env.js'
import { createMacaroonRootKey } from './security/macaroon-root-key.js'
import { createWorkspaceReplicaKeyStore } from './security/workspace-replica-key-store.js'
import {
  createRootShutdown,
  createSharedWorkers,
  sharedBackgroundWork,
} from './shared-background-work.js'
import type { createBackupScheduler } from './store/backup-scheduler.js'
import type { createFileGcSweeper } from './store/file-gc-sweeper.js'
import type { createWorkspaceTail } from './store/workspace-tail.js'
import { openSyncStreamCount, syncStreamStats } from './sync-streams.js'

/**
 * The local daemon. It listens on ONE owner-only socket — a Unix socket, or a
 * named pipe on Windows — and on no TCP port (ADR-0050 decisions 2-4): the
 * hosted app reaches it through the extension's native host, and the CLI and
 * the stdio proxy reach it there too. Server mode's HTTP listener is
 * `server-mode-http.ts`.
 */
export interface StartHttpServerOptions {
  /** Where to listen (`daemon-socket.ts`'s `daemonSocketPath`). */
  socketPath: string
  token?: string
  idleTimeoutMs?: number
  onClose?: () => Promise<void> | void
  /** Test-only seam: overrides the real createFileGcSweeper so wiring tests
   *  can observe start/stop without waiting on a real 24h interval. */
  fileGcSweeperFactory?: typeof createFileGcSweeper
  /** Test seam, matching `fileGcSweeperFactory`. Composition is the one thing
   *  a unit test of the tail itself cannot reach, and "started and stopped
   *  exactly once, and only when configured" is the part that would fail
   *  silently. */
  workspaceTailFactory?: typeof createWorkspaceTail
  /** Test seam, matching the two above. Composition is the one thing a unit
   *  test of the scheduler itself cannot reach, and "started and stopped
   *  exactly once, and only when a destination is configured" is the part
   *  that would fail silently. */
  backupSchedulerFactory?: typeof createBackupScheduler
  /** The read plane's default tier (WHITEBOARD_REPLICA_TIER, replica-env.ts).
   *  Defaults to `offline` when omitted — see replica-env.ts's own default. */
  replicaTier?: ReplicaTier
  /** How long a `bounded`-tier lease lasts (WHITEBOARD_REPLICA_LEASE_TTL_MS).
   *  Defaults to 7 days when omitted. */
  replicaLeaseTtlMs?: number
}

export interface RunningServer {
  /** Unique per process-start id; used by CLI stop/status/doctor to verify
   *  they are talking to the daemon they recorded, not a PID-reuse impostor. */
  instanceId: string
  /** The socket it answers on. */
  socketPath: string
  close: () => Promise<void>
  touch: () => void
  getRuntimeStatus: () => RuntimeStatusResponse
}

export async function startHttpServer(options: StartHttpServerOptions): Promise<RunningServer> {
  await startHttpRootTracing('daemon')
  const instanceId = randomUUID()
  const startedAtMs = Date.now()
  const startedAt = new Date(startedAtMs).toISOString()
  let socketListener: Awaited<ReturnType<typeof listenOnSocket>> | undefined

  // Booted before the workers so they serve the directory the deps were booted
  // over (`scope`). Prepared and migrated before the ports get a handle — see
  // `prepareSelfHostDataDir` for what each step's absence produced.
  const { db, serverDeps: bootedDeps, dataLayout, scope } = await bootLocalDeps(getDataDir())
  const shared = createSharedWorkers(instanceId, scope, options)

  // A page holding a sync stream makes no request while nobody types, and
  // must not have the daemon stop under it.
  const idleTimer = new IdleTimer(
    options.idleTimeoutMs ?? 15 * 60_000,
    () => {
      void close()
    },
    undefined,
    () => openSyncStreamCount() > 0,
  )

  const touch = () => idleTimer.touch()
  const getRuntimeStatus = (): RuntimeStatusResponse => {
    const stats = syncStreamStats()
    return {
      ok: true,
      pid: process.pid,
      socketPath: options.socketPath,
      version: PACKAGE_VERSION,
      startedAt,
      uptimeMs: Date.now() - startedAtMs,
      idleForMs: idleTimer.getIdleForMs(),
      auth: { mode: 'local-token', hasToken: Boolean(options.token) },
      storage: {
        dataDir: scope.dataDir,
        dataDirWritable: isDataDirWritable(scope.dataDir),
      },
      mcp: { httpEnabled: true },
      clients: stats,
    }
  }

  const close = createRootShutdown({
    stopBackgroundWork: () => backgroundWork.stopAll(),
    closeListener: async () => {
      await socketListener?.close()
    },
    afterListenerClosed: () => options.onClose?.(),
    flushCheckpoints: shared.checkpoints.flush,
  })

  // ADR-0043 decision 4's root key, loaded or created once here. A composition
  // that forgets it does not fail loudly, it refuses every macaroon.
  const macaroonRootKey = createMacaroonRootKey({ dataDir: scope.dataDir }).rootKey

  // /api/v1 document surface: same libSQL database as the MCP tools
  // (getDb memoizes per dataDir, so this container shares the connection
  // with the per-session MCP containers rather than opening a second one).
  // The read plane's workspace-key store (ADR-0042 decisions 1/3/5), built
  // from the same post-migration handle as the container above.
  const replicaKeys = createWorkspaceReplicaKeyStore(db, {
    defaultTier: options.replicaTier ?? DEFAULT_REPLICA_TIER,
  })
  const serverDeps = attachLiveAudience(bootedDeps)

  const app = createApp({
    authMode: 'local-daemon',
    onAutoVersionTrigger: shared.checkpoints.capture,
    token: options.token,
    instanceId,
    touch,
    getStatus: getRuntimeStatus,
    replicaKeys,
    replicaLeaseTtlMs: options.replicaLeaseTtlMs,
    macaroonRootKey,
    serverDeps,
    dataLayout,
  })

  // Everything the daemon runs on its own goes through the registry, which is
  // where each one answers who runs it and what it costs the serving loop.
  // See background-work.ts for why that is a registry rather than four calls.
  const backgroundWork = startBackgroundWork([
    ...sharedBackgroundWork(shared),
    {
      name: 'idle-shutdown',
      trigger: `no request for ${options.idleTimeoutMs ?? 15 * 60_000}ms and no sync stream open`,
      instances: {
        runs: 'every-instance',
        because: 'it is about THIS process being idle, which no other process can answer for it',
      },
      loop: LOOP_COSTS['idle-shutdown'],
      worker: { start: () => idleTimer.start(), stop: async () => idleTimer.stop() },
    },
  ])

  // A socket that cannot be made safe (another user's directory, a daemon
  // still answering on it) stops the daemon rather than leaving it
  // half-started with its background work running.
  try {
    socketListener = await listenOnSocket(app.fetch, options.socketPath)
  } catch (err) {
    await close()
    throw err
  }

  return {
    instanceId,
    socketPath: socketListener.path,
    close,
    touch,
    getRuntimeStatus,
  }
}
