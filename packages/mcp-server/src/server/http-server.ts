import { randomUUID } from 'node:crypto'
import { accessSync, existsSync, constants as fsConstants } from 'node:fs'
import type { Socket } from 'node:net'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import type { RuntimeStatusResponse } from '@kamiazya/whiteboard-daemon-client/api-contracts/runtime'
import { WHITEBOARD_WS_PROTOCOL } from '@kamiazya/whiteboard-daemon-client/ws-protocol'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { WebSocketServer } from 'ws'
import { IdleTimer } from '../daemon/idle-timer.js'
import { createContainer, resolveServerDeps } from '../di/container.js'
import { createStoreLocalModule } from '../di/store-local.module.js'
import { PACKAGE_VERSION } from '../shared/package-version.js'
import { createApp } from './app.js'
import { startBackgroundWork } from './background-work.js'
import { LOOP_COSTS } from './background-work-costs.js'
import { createCanvasClientNotifier } from './canvas-client-notifier.js'
import { DIST_WEB_APP_DIR, getDataDir } from './config.js'
import { ensureWorkspaceId } from './current-workspace.js'
import { buildDaemonBaseUrl, normalizeBindHost } from './daemon-auth-binding.js'
import { getLogger } from './log.js'
import type { AutoVersionTrigger } from './routes/document.js'
import {
  getConnectionStats,
  handleWsUpgrade,
  installWsUpdateFanout,
  setRuntimeTouchFn,
  subscribedWorkspaceIds,
} from './routes/ws.js'
import { authorizeWsUpgrade } from './routes/ws-auth.js'
import { parseWsTargetFromRequestUrl } from './routes/ws-validation.js'
import type { McpHttpAuthStrategy } from './security/mcp-auth.js'
import type { OAuthClientRegistry } from './security/oauth-authz-registry.js'
import { createPairingGrantStore } from './security/pairing-grant-store.js'
import { createPairingCodeStore, createPairingTokenStore } from './security/pairing-session.js'
import { createWsTicketStore } from './security/ws-ticket-store.js'
import { createBackupLease, createBackupScheduler } from './store/backup-scheduler.js'
import { getDb } from './store/db/index.js'
import { prepareDataDir } from './store/db/prepare.js'
import {
  cacheBackedWorkspaceDocs,
  emitWorkspaceDocUpdated,
  getWorkspaceDoc,
} from './store/document-store.js'
import { createFileGcSweeper, type FileGcSweeper } from './store/file-gc-sweeper.js'
import { parseBackupDir, parseBackupKeep, parseBackupSchedule } from './store/storage-env.js'
import { createWorkspaceTail, resolveWorkspaceTailIntervalMs } from './store/workspace-tail.js'
import { validationErrorBody } from './validators.js'

export type RuntimeStatus = RuntimeStatusResponse

export interface StartHttpServerOptions {
  port: number
  host?: string
  token?: string
  mcpAuth?: McpHttpAuthStrategy
  idleTimeoutMs?: number
  onClose?: () => Promise<void> | void
  /** Exact-match hosted origins admitted alongside loopback, on /api CORS,
   *  /mcp, and WS upgrade (WHITEBOARD_ALLOWED_WEB_ORIGINS). Empty by default. */
  allowedWebOrigins?: readonly string[]
  /** Registered OAuth clients and their exact redirect_uris
   *  (WHITEBOARD_OAUTH_CLIENT_REGISTRY). Empty by default, which leaves the
   *  hosted-origin authorization-server surface entirely unmounted. */
  oauthClientRegistry?: OAuthClientRegistry
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
  /** Test-only seam: overrides `process.exit` for the fatal-bind-error path
   *  below, so a test can observe the exit call instead of actually killing
   *  the test process. */
  exitProcess?: (code: number) => void
}

export interface RunningServer {
  port: number
  /** Unique per process-start id; used by CLI stop/status/doctor to verify
   *  they are talking to the daemon they recorded, not a PID-reuse impostor. */
  instanceId: string
  close: () => Promise<void>
  touch: () => void
  getRuntimeStatus: () => RuntimeStatus
}

type ClosableHttpServer = ReturnType<typeof serve> & {
  closeIdleConnections?: () => void
  closeAllConnections?: () => void
}

// Bounds how long close() waits for an in-flight file-gc pass (see
// file-gc-sweeper.ts's FileGcSweeperStopOptions) before proceeding with the
// rest of shutdown. A full pass can be expensive; without this cap an
// idle-timeout-triggered close() could make the daemon appear to hang
// instead of shutting down promptly.
const FILE_GC_STOP_TIMEOUT_MS = 5_000

export async function startHttpServer(options: StartHttpServerOptions): Promise<RunningServer> {
  const host = normalizeBindHost(options.host ?? '127.0.0.1')
  const instanceId = randomUUID()
  const startedAtMs = Date.now()
  const startedAt = new Date(startedAtMs).toISOString()
  let server: ReturnType<typeof serve>
  let wss: WebSocketServer
  let closePromise: Promise<void> | null = null
  const sockets = new Set<Socket>()

  // Constructed once per daemon start, independent of the WS ticket store
  // above -- there is no shared-instance hazard here (see
  // file-gc-sweeper.ts's own comment on why it constructs its own
  // FileVersionStore), so this can be created any time before close() needs
  // to reference it.
  const fileGcSweeper: FileGcSweeper = (options.fileGcSweeperFactory ?? createFileGcSweeper)()

  // Off unless an operator turns it on: one daemon learns about its own
  // writes through `onWorkspaceDocUpdated` already, and polling for a second
  // instance that does not exist is pure cost. See ADR-0020.
  // Off unless a destination is configured (ADR-0021 decision 4). The ADR
  // asks for backups to be handled rather than remembered, and this is what
  // handles them — but there is no destination worth guessing, so an operator
  // still has to say where. `collectStorageEnvIssues` refuses an interval or
  // a retention count set without one, so a half-configured schedule fails at
  // startup rather than silently doing nothing.
  const backupDir = parseBackupDir(process.env)
  const backupSchedule = parseBackupSchedule(process.env)
  const backupKeep = parseBackupKeep(process.env)
  const backupScheduler = (options.backupSchedulerFactory ?? createBackupScheduler)({
    dataDir: getDataDir(),
    backupDir: backupDir.ok ? backupDir.value : null,
    ...(backupSchedule.ok ? { schedule: backupSchedule.value } : {}),
    ...(backupKeep.ok && backupKeep.value !== null ? { keep: backupKeep.value } : {}),
    // ADR-0020's leader election, so a deployment running several instances
    // over one data directory takes ONE backup a night rather than one per
    // instance — whose retention passes would each delete from a set the
    // others are changing. A single daemon takes the lease unopposed, so
    // this is not conditional on being multi-instance: nothing here knows
    // whether it is, and a deployment that grows a second instance must not
    // depend on someone remembering to turn coordination on.
    runExclusively: createBackupLease({ holder: instanceId }),
  })

  const workspaceTailIntervalMs = resolveWorkspaceTailIntervalMs()
  const workspaceTail =
    workspaceTailIntervalMs === null
      ? null
      : (options.workspaceTailFactory ?? createWorkspaceTail)({
          subscribedWorkspaces: subscribedWorkspaceIds,
          docs: cacheBackedWorkspaceDocs(),
          // The CACHED document, which is what every reader on this instance
          // is served from — catching up a fresh copy would leave the one
          // people actually read untouched.
          liveDoc: getWorkspaceDoc,
          emit: emitWorkspaceDocUpdated,
          intervalMs: workspaceTailIntervalMs,
        })

  const idleTimer = new IdleTimer(options.idleTimeoutMs ?? 15 * 60_000, () => {
    void close()
  })

  const touch = () => idleTimer.touch()
  const getRuntimeStatus = (): RuntimeStatusResponse => {
    const stats = getConnectionStats()
    return {
      ok: true,
      pid: process.pid,
      host,
      port: options.port,
      baseUrl: `http://${host}:${options.port}`,
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
      app: {
        served: true,
        buildPresent: existsSync(join(DIST_WEB_APP_DIR, 'index.html')),
        ui: 'pair-only',
      },
      mcp: { httpEnabled: true, endpoint: `http://${host}:${options.port}/mcp` },
      clients: { connected: stats.connectedClients, ready: stats.readyClients },
    }
  }

  const performClose = async (): Promise<void> => {
    await backgroundWork.stopAll()
    setRuntimeTouchFn(() => {})

    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err)
          return
        }
        resolve()
      })
      const closeableServer = server as ClosableHttpServer
      // Idle shutdown must not leave keep-alive HTTP sockets behind, otherwise the
      // process can linger in a half-closed state where WS upgrades return 503.
      closeableServer.closeIdleConnections?.()
      closeableServer.closeAllConnections?.()
      for (const socket of sockets) {
        socket.destroy()
      }
    })

    for (const client of wss.clients) {
      client.terminate()
    }
    await new Promise<void>((resolve) => wss.close(() => resolve()))

    await options.onClose?.()

    // A SECOND flush, after the listener is closed and every in-flight
    // request has finished.
    //
    // The registry's stop already flushed, and that one is not redundant: it
    // is what runs on a bind-failure teardown, where there is no server to
    // close. But `server.close()` keeps serving the requests already in
    // progress, and an update handler completing during that window arms a
    // fresh debounce — against a timer that is `unref`ed and will never fire,
    // so the checkpoint it scheduled would leave with the process. Flushing
    // once more here is the point at which no handler can arm another.
    await autoVersionTrigger?.flush()
  }

  // Memoized so concurrent/repeated close() calls (idle timeout racing an
  // explicit shutdown route, or a caller invoking close() twice) all await
  // the SAME shutdown instead of a second call resolving immediately while
  // the listener and WebSockets are still tearing down.
  const close = (): Promise<void> => {
    if (!closePromise) closePromise = performClose()
    return closePromise
  }

  // Shared with the raw `upgrade` handler below (ADR-0005): a ticket minted
  // by the POST /api/ws-ticket route mounted inside `app` must be redeemable
  // by the WS upgrade that follows it, which happens outside Hono entirely.
  // Two separate store instances would mean every minted ticket 401s at
  // upgrade — the route and the upgrade path have to agree on which store.
  const wsTicketStore = createWsTicketStore()

  // Pairing-grant flow: durable origin grants + in-memory codes/tokens.
  // The allowlist PROVIDER folds granted origins into the env-configured
  // set per request, so an Approve on /pair takes effect on /api, /mcp,
  // and WS without a restart (see the tri-surface provider contract test).
  const pairingGrants = createPairingGrantStore(getDataDir())
  const pairing = {
    grants: pairingGrants,
    codes: createPairingCodeStore(),
    tokens: createPairingTokenStore(),
  }
  const envWebOrigins = options.allowedWebOrigins ?? []
  const allowedWebOrigins = () => {
    const grantOrigins = pairingGrants.origins()
    if (grantOrigins.length === 0 && Array.isArray(envWebOrigins)) return envWebOrigins
    return [...envWebOrigins, ...grantOrigins]
  }

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
  const resolvedDeps = resolveServerDeps(
    createContainer(createStoreLocalModule({ db: await getDb(dataDir), blobDir: dataDir })),
  )
  // The WS-route bridge is attached HERE, not in resolveServerDeps: the di
  // graph must not import the routes layer (value cycle), and this root is
  // one of the two places a live-socket audience exists.
  const serverDeps: ServerDeps = {
    ...resolvedDeps,
    clientNotifier: createCanvasClientNotifier(resolvedDeps.documentIndex),
  }
  // Eagerly, not only per-upgrade: an SSE-only audience (or a workspace-tail
  // record arriving before any socket) must reach connected ws clients the
  // moment the first one appears — and the ws fan-out listener costs nothing
  // while nobody is connected.
  installWsUpdateFanout(serverDeps)

  // Filled synchronously by createApp below, and read only by the
  // auto-checkpoint declaration's stop() — which runs long after.
  let autoVersionTrigger: AutoVersionTrigger | undefined
  const app = createApp({
    authMode: 'local-daemon',
    onAutoVersionTrigger: (trigger) => {
      autoVersionTrigger = trigger
    },
    token: options.token,
    mcpAuth: options.mcpAuth,
    instanceId,
    touch,
    getStatus: getRuntimeStatus,
    shutdown: close,
    allowedWebOrigins,
    oauthClientRegistry: options.oauthClientRegistry,
    wsTicketStore,
    pairing,
    serverDeps,
    // host is the bare form normalizeBindHost produced for server.listen();
    // pairing-link.ts parses this string with `new URL(...)`, which needs
    // an IPv6 literal bracketed.
    daemonBaseUrl: buildDaemonBaseUrl(host, options.port),
  })

  setRuntimeTouchFn(touch)
  // Everything the daemon runs on its own goes through the registry, which is
  // where each one answers who runs it and what it costs the serving loop.
  // See background-work.ts for why that is a registry rather than four calls.
  const backgroundWork = startBackgroundWork([
    {
      name: 'auto-checkpoint',
      trigger: 'a document update, taken once that document has been quiet for five minutes',
      instances: {
        runs: 'every-instance',
        because:
          'the debounce is about documents THIS process is holding edits for — another ' +
          'instance has neither the pending timer nor the LoroDoc the checkpoint would be ' +
          'taken from, so a leader could not take it',
      },
      loop: LOOP_COSTS['auto-checkpoint'],
      // Nothing to arm: the trigger schedules itself from the update that
      // signalled it, which is why it is declared here for its STOP rather
      // than its start. A trailing debounce loses exactly the checkpoint it
      // exists to take if the process goes away without flushing — the one
      // at the pause where editing stopped — so shutting down TAKES the
      // pending checkpoints instead of dropping them.
      worker: {
        start: () => {},
        stop: async () => {
          await autoVersionTrigger?.flush()
        },
      },
    },
    {
      name: 'idle-shutdown',
      trigger: `no request for ${options.idleTimeoutMs ?? 15 * 60_000}ms`,
      instances: {
        runs: 'every-instance',
        because: 'it is about THIS process being idle, which no other process can answer for it',
      },
      loop: LOOP_COSTS['idle-shutdown'],
      worker: { start: () => idleTimer.start(), stop: async () => idleTimer.stop() },
    },
    {
      name: 'file-gc-sweeper',
      trigger: `every WHITEBOARD_FILE_GC_INTERVAL_MS (24h by default); the sweeper resolves it`,
      instances: {
        runs: 'every-instance',
        because:
          'ADR-0020 rejects a GC leader explicitly: it removes GC-versus-GC races and leaves ' +
          'GC-versus-WRITE untouched, since the write barrier is in-process and another ' +
          "instance's write never takes it. The grace period is what covers that window.",
      },
      loop: LOOP_COSTS['file-gc-sweeper'],
      // Wrapped rather than passed straight through: its own `stop` takes a
      // cap on how long shutdown waits for an in-flight pass, and a pass can
      // be expensive. Handing the bare method to a caller that passes no
      // options would silently take the sweeper's default instead.
      worker: {
        start: () => fileGcSweeper.start(),
        stop: () => fileGcSweeper.stop({ timeoutMs: FILE_GC_STOP_TIMEOUT_MS }),
      },
    },
    {
      name: 'workspace-tail',
      trigger: `every ${workspaceTailIntervalMs ?? 0}ms`,
      instances: {
        runs: 'every-instance',
        because:
          'each instance is catching ITS OWN cached documents up with what another instance ' +
          'wrote; a leader doing it would leave every follower serving stale reads',
      },
      loop: LOOP_COSTS['workspace-tail'],
      worker: workspaceTail,
    },
    {
      name: 'backup-scheduler',
      trigger: backupSchedule.ok ? backupSchedule.value.expression : '0 3 * * *',
      instances: { runs: 'leader-only', lease: 'backup' },
      loop: LOOP_COSTS['backup-scheduler'],
      worker: backupScheduler,
    },
  ])

  server = serve({ fetch: app.fetch, port: options.port, hostname: host })
  // `serve()` returns before the underlying bind resolves, so a bind failure
  // (EADDRINUSE from a losing concurrent bootstrap, EACCES from a privileged
  // port) would otherwise hit Node's default 'error' behavior: an unhandled
  // throw dumping a raw stack trace to this process's stdio. Log one
  // classified, path-free record instead and exit, per this package's
  // no-console / no-leaked-path logging discipline.
  server.on('error', (err: NodeJS.ErrnoException) => {
    const log = getLogger('http-server')
    log.error({ port: options.port, code: err.code ?? 'unknown' }, 'http listener failed to bind')
    // A real process.exit() would terminate the process outright, making
    // these timers moot. But `exitProcess` is an injectable seam (tests pass
    // a no-op stub), so without an explicit stop here the 15-min idle timer
    // and the GC sweeper's interval would keep firing in whatever process
    // hosts this call for the seam's lifetime.
    void backgroundWork.stopAll()
    ;(options.exitProcess ?? process.exit)(1)
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => {
      sockets.delete(socket)
    })
  })
  wss = new WebSocketServer({
    noServer: true,
    // Per-frame limit. Keep enough room for Loro snapshots and large image imports
    // (8 MiB) while avoiding OOM if a malicious client sends the ws default 100 MiB.
    // When exceeded, ws closes the connection automatically with 1009 (Message Too Big).
    maxPayload: 8 * 1024 * 1024,
    handleProtocols: (protocols) =>
      protocols.has(WHITEBOARD_WS_PROTOCOL) ? WHITEBOARD_WS_PROTOCOL : false,
  })

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    if (!url.pathname.startsWith('/ws/')) {
      socket.destroy()
      return
    }
    const decision = authorizeWsUpgrade(
      req.headers,
      options.token,
      allowedWebOrigins,
      wsTicketStore.redeemTicket,
      pairing.tokens,
    )
    if (!decision.accept) {
      const statusCode = decision.statusCode ?? 401
      const statusText = statusCode === 403 ? 'Forbidden' : 'Unauthorized'
      socket.write(`HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\n\r\n`)
      socket.destroy()
      return
    }
    try {
      parseWsTargetFromRequestUrl(req.url, req.headers.host ?? 'localhost')
    } catch (error) {
      const issue = validationErrorBody(error)
      const body = issue ? JSON.stringify(issue) : ''
      socket.write(
        `HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
      )
      socket.destroy()
      return
    }
    touch()
    wss.handleUpgrade(req, socket, head, (ws) => {
      void handleWsUpgrade(req, ws, decision.scopes, serverDeps)
    })
  })

  return {
    port: options.port,
    instanceId,
    close,
    touch,
    getRuntimeStatus,
  }
}
