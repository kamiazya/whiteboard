import { randomUUID } from 'node:crypto'
import { accessSync, constants as fsConstants } from 'node:fs'
import type { ReplicaTier } from '@kamiazya/whiteboard-daemon-client/api-contracts/replica-key'
import type { RuntimeStatusResponse } from '@kamiazya/whiteboard-daemon-client/api-contracts/runtime'
import type { FacetPlugin } from '@kamiazya/whiteboard-facet-engine'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { listenOnSocket } from '../daemon/daemon-socket.js'
import { IdleTimer } from '../daemon/idle-timer.js'
import { createContainer, resolveServerDeps } from '../di/container.js'
import { createSelfHostStoreLocalModule } from '../di/store-local.module.js'
import { PACKAGE_VERSION } from '../shared/package-version.js'
import { createApp } from './app.js'
import { startBackgroundWork } from './background-work.js'
import { LOOP_COSTS } from './background-work-costs.js'
import { createCanvasClientNotifier } from './canvas-client-notifier.js'
import { getDataDir } from './config.js'
import { ensureWorkspaceId } from './current-workspace.js'
import { daemonDeviceActor } from './daemon-actor.js'
import { DEFAULT_REPLICA_TIER } from './replica-env.js'
import type { AutoVersionTrigger } from './routes/document.js'
import { openSyncStreamCount, syncStreamStats } from './routes/sync-sse.js'
import { createMacaroonRootKey } from './security/macaroon-root-key.js'
import type { McpProtectedResourceMetadataConfig } from './security/mcp-auth.js'
import { createWorkspaceReplicaKeyStore } from './security/workspace-replica-key-store.js'
import {
  createSharedWorkers,
  FILE_GC_STOP_TIMEOUT_MS,
  sharedBackgroundWork,
} from './shared-background-work.js'
import type { createBackupScheduler } from './store/backup-scheduler.js'
import { getDb } from './store/db/index.js'
import { prepareDataDir } from './store/db/prepare.js'
import type { createFileGcSweeper } from './store/file-gc-sweeper.js'
import type { createWorkspaceTail } from './store/workspace-tail.js'

export type RuntimeStatus = RuntimeStatusResponse

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
  mcpProtectedResourceMetadata?: McpProtectedResourceMetadataConfig
  idleTimeoutMs?: number
  onClose?: () => Promise<void> | void
  /**
   * The plugin set this deployment registers (ADR-0013 decision 3), default
   * the bundled one. A distribution that embeds this daemon composes its own
   * set here — in code, which is what distribution time means; there is
   * deliberately no config file naming modules to import.
   */
  facetPlugins?: readonly FacetPlugin[]
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
  getRuntimeStatus: () => RuntimeStatus
}

export async function startHttpServer(options: StartHttpServerOptions): Promise<RunningServer> {
  const instanceId = randomUUID()
  const startedAtMs = Date.now()
  const startedAt = new Date(startedAtMs).toISOString()
  let closePromise: Promise<void> | null = null
  let socketListener: Awaited<ReturnType<typeof listenOnSocket>> | undefined

  const shared = createSharedWorkers(instanceId, options)

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
        dataDir: getDataDir(),
        dataDirWritable: (() => {
          try {
            accessSync(getDataDir(), fsConstants.W_OK)
            return true
          } catch {
            return false
          }
        })(),
      },
      mcp: { httpEnabled: true },
      clients: stats,
    }
  }

  const performClose = async (): Promise<void> => {
    await backgroundWork.stopAll()
    await socketListener?.close()

    await options.onClose?.()

    // A SECOND flush, after the listener is closed and every in-flight
    // request has finished.
    //
    // The registry's stop already flushed, and that one is not redundant: it
    // is what runs on a listen-failure teardown, where there is no server to
    // close. But closing the listener keeps serving the requests already in
    // progress, and an update handler completing during that window arms a
    // fresh debounce — against a timer that is `unref`ed and will never fire,
    // so the checkpoint it scheduled would leave with the process. Flushing
    // once more here is the point at which no handler can arm another.
    await autoVersionTrigger?.flush()
  }

  // Memoized so concurrent/repeated close() calls (idle timeout racing an
  // explicit shutdown route, or a caller invoking close() twice) all await
  // the SAME shutdown instead of a second call resolving immediately while
  // the listener is still tearing down.
  const close = (): Promise<void> => {
    if (!closePromise) closePromise = performClose()
    return closePromise
  }

  // ADR-0043 decision 4's root key, loaded or created once here. A composition
  // that forgets it does not fail loudly, it refuses every macaroon.
  const macaroonRootKey = createMacaroonRootKey({ dataDir: getDataDir() }).rootKey

  // /api/v1 document surface: same libSQL database as the MCP tools
  // (getDb memoizes per dataDir, so this container shares the connection
  // with the per-session MCP containers rather than opening a second one).
  const dataDir = getDataDir()
  // Migrate BEFORE handing the ports a handle. `getDb` opens the file and
  // nothing more; migrations have only ever run through `document-store.ts`'s
  // `dbReady`, which is `prepareDataDir` then `getDb`. Anything reaching the
  // injected ports instead of the legacy store therefore met an empty schema
  // on a data dir nothing had touched yet — `/api/v1` answered
  // `no such table: workspaces` from the day it was mounted. Both are
  // memoized per data dir, so on an already-prepared dir this costs nothing.
  await prepareDataDir(dataDir)
  // And give the daemon its current workspace before anything reads the list.
  // `ensureWorkspaceId` had only ever run per `/mcp` request, so a daemon a
  // browser reached first held no workspace at all: `GET /api/workspaces`
  // answered `{"workspaces":[]}` (measured on a fresh data dir), which is not
  // a state the document browser can select out of. Memoized per data dir, so
  // the per-request MCP callers below share this one resolve.
  await ensureWorkspaceId(dataDir)
  const db = await getDb(dataDir)
  const resolvedDeps = resolveServerDeps(
    createContainer(createSelfHostStoreLocalModule(db, dataDir)),
    {
      ...(options.facetPlugins === undefined ? {} : { plugins: options.facetPlugins }),
      daemonActor: daemonDeviceActor(dataDir),
    },
  )
  // The read plane's workspace-key store (ADR-0042 decisions 1/3/5), built
  // from the same post-migration handle as the container above.
  const replicaKeys = createWorkspaceReplicaKeyStore(db, {
    defaultTier: options.replicaTier ?? DEFAULT_REPLICA_TIER,
  })
  // The live-audience bridge is attached HERE, not in resolveServerDeps: the
  // di graph must not import the routes layer (value cycle), and this root is
  // one of the two places a live audience exists.
  const serverDeps: ServerDeps = {
    ...resolvedDeps,
    clientNotifier: createCanvasClientNotifier(resolvedDeps.documentIndex),
  }

  // Filled synchronously by createApp below, and read only by the
  // auto-checkpoint declaration's stop() — which runs long after.
  let autoVersionTrigger: AutoVersionTrigger | undefined
  const app = createApp({
    authMode: 'local-daemon',
    onAutoVersionTrigger: (trigger) => {
      autoVersionTrigger = trigger
    },
    token: options.token,
    mcpProtectedResourceMetadata: options.mcpProtectedResourceMetadata,
    instanceId,
    touch,
    getStatus: getRuntimeStatus,
    replicaKeys,
    replicaLeaseTtlMs: options.replicaLeaseTtlMs,
    macaroonRootKey,
    serverDeps,
  })

  // Everything the daemon runs on its own goes through the registry, which is
  // where each one answers who runs it and what it costs the serving loop.
  // See background-work.ts for why that is a registry rather than four calls.
  const backgroundWork = startBackgroundWork([
    ...sharedBackgroundWork(shared, {
      flushCheckpoints: async () => {
        await autoVersionTrigger?.flush()
      },
      fileGc: {
        start: () => shared.fileGcSweeper.start(),
        stop: () => shared.fileGcSweeper.stop({ timeoutMs: FILE_GC_STOP_TIMEOUT_MS }),
      },
    }),
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
