import type { CheckpointScheduler } from '@kamiazya/whiteboard-history'
import type { BackgroundWork, BackgroundWorker } from './background-work.js'
import { LOOP_COSTS } from './background-work-costs.js'
import { getDataDir } from './config.js'
import { createAutoVersionTrigger } from './routes/document/auto-version.js'
import { subscribedWorkspaceIds } from './routes/sync-audience.js'
import { installAutoCheckpoint } from './store/auto-checkpoint.js'
import {
  disposeAutoCompact,
  installAutoCompact,
  uninstallAutoCompact,
} from './store/auto-compact.js'
import { createBackupLease, createBackupScheduler } from './store/backup-scheduler.js'
import {
  cacheBackedWorkspaceDocs,
  emitWorkspaceDocUpdated,
  getWorkspaceDoc,
} from './store/document-store.js'
import { createFileGcSweeper, type FileGcSweeper } from './store/file-gc-sweeper.js'
import { parseBackupDir, parseBackupKeep, parseBackupSchedule } from './store/storage-env.js'
import { FileVersionStore } from './store/version-store.js'
import { createWorkspaceTail, resolveWorkspaceTailIntervalMs } from './store/workspace-tail.js'

/**
 * The background work BOTH HTTP composition roots run — the local daemon
 * (`http-server.ts`) and server mode (`server-mode-http.ts`) — built and
 * declared once.
 *
 * Each root used to carry its own copy of these four declarations, each with
 * its own copy of the rationale, and a worker added to one root was simply
 * absent from the other: server mode, the MULTI-INSTANCE deployment the
 * backup lease was built for, took no scheduled backups at all until someone
 * noticed its registry call declared nothing. The registry made that
 * visible; this is what makes it structural. A worker added here reaches
 * both roots, and a root that wants the shared set has to supply every seam
 * the type names.
 *
 * What stays in each root is what is genuinely its own: the local daemon's
 * `idle-shutdown` (server mode never idles out), and the one-line wrapper
 * that arms each worker INSIDE its `startBackgroundWork` call, which is
 * where `background-work.guard.test.ts` requires a `.start()` to be.
 */

/**
 * Caps how long close() waits for an in-flight file-gc pass before the rest
 * of shutdown proceeds. A full pass can be expensive, and a shutdown that
 * appears to hang is worse than one that leaves a pass to finish in the
 * background.
 */
export const FILE_GC_STOP_TIMEOUT_MS = 5_000

export interface RootShutdownSteps {
  /** The registry's `stopAll`; read at close time because the registry is armed after this is built. */
  stopBackgroundWork: () => Promise<void>
  /** Stops accepting connections and waits out the in-flight ones. */
  closeListener: () => Promise<void>
  /** A root's own teardown that must follow the listener, before the final flush. */
  afterListenerClosed?: () => Promise<void> | void
  /** Takes the pending checkpoints; the trigger is handed back by `createApp`, so read at close time. */
  flushCheckpoints: () => Promise<void>
}

/**
 * The shutdown both HTTP roots run, memoized so concurrent or repeated
 * close() calls (an idle timeout racing an explicit shutdown, or a caller
 * invoking it twice) all await the SAME shutdown rather than a second call
 * resolving while the listener is still tearing down.
 */
export function createRootShutdown(steps: RootShutdownSteps): () => Promise<void> {
  const perform = async (): Promise<void> => {
    await steps.stopBackgroundWork()
    await steps.closeListener()
    await steps.afterListenerClosed?.()

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
    await steps.flushCheckpoints()
  }
  let closing: Promise<void> | null = null
  return () => {
    closing ??= perform()
    return closing
  }
}

export interface SharedWorkerFactories {
  /** Test seam: overrides the real sweeper so a wiring test can observe start/stop. */
  fileGcSweeperFactory?: typeof createFileGcSweeper
  /** Test seam, matching `fileGcSweeperFactory`. */
  workspaceTailFactory?: typeof createWorkspaceTail
  /** Test seam, matching the two above. */
  backupSchedulerFactory?: typeof createBackupScheduler
}

export interface SharedWorkers {
  readonly fileGcSweeper: FileGcSweeper
  readonly workspaceTail: BackgroundWorker | null
  readonly workspaceTailIntervalMs: number | null
  readonly backupScheduler: BackgroundWorker
  /** The cron expression the backup pass runs on, for the declaration's trigger. */
  readonly backupTrigger: string
}

/**
 * Constructs the shared workers from the environment and this instance's
 * identity. Construction only — nothing here is armed; `sharedBackgroundWork`
 * below declares them, and the root's registry call arms them.
 */
export function createSharedWorkers(
  instanceId: string,
  factories: SharedWorkerFactories = {},
): SharedWorkers {
  // Constructed once per start. There is no shared-instance hazard here (see
  // file-gc-sweeper.ts's own comment on why it constructs its own
  // FileVersionStore).
  const fileGcSweeper = (factories.fileGcSweeperFactory ?? createFileGcSweeper)()

  // Off unless a destination is configured (ADR-0021 decision 4). The ADR
  // asks for backups to be handled rather than remembered, and this is what
  // handles them — but there is no destination worth guessing, so an operator
  // still has to say where. `collectStorageEnvIssues` refuses an interval or
  // a retention count set without one, so a half-configured schedule fails at
  // startup rather than silently doing nothing.
  const backupDir = parseBackupDir(process.env)
  const backupSchedule = parseBackupSchedule(process.env)
  const backupKeep = parseBackupKeep(process.env)
  const backupScheduler = (factories.backupSchedulerFactory ?? createBackupScheduler)({
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

  // Several instances share one record (ADR-0020 decision 5), and the tail is
  // how a browser on THIS one learns what another wrote. Off unless the
  // operator sets the interval: one instance hears all its own writes
  // through `onWorkspaceDocUpdated` already, and polling for a second
  // instance that does not exist is pure cost.
  const workspaceTailIntervalMs = resolveWorkspaceTailIntervalMs()
  const workspaceTail =
    workspaceTailIntervalMs === null
      ? null
      : (factories.workspaceTailFactory ?? createWorkspaceTail)({
          subscribedWorkspaces: subscribedWorkspaceIds,
          docs: cacheBackedWorkspaceDocs(),
          // The CACHED document, which is what every reader on this instance
          // is served from — catching up a fresh copy would leave the one
          // people actually read untouched.
          liveDoc: getWorkspaceDoc,
          emit: emitWorkspaceDocUpdated,
          intervalMs: workspaceTailIntervalMs,
        })

  return {
    fileGcSweeper,
    workspaceTail,
    workspaceTailIntervalMs,
    backupScheduler,
    backupTrigger: backupSchedule.ok ? backupSchedule.value.expression : '0 3 * * *',
  }
}

export interface SharedWorkerArming {
  /**
   * The checkpoint scheduler `createApp` built, which the router's own update
   * path signals directly. Read at START and STOP time rather than captured,
   * because it is handed back by `createApp` after the workers are built.
   */
  checkpointScheduler: () => CheckpointScheduler | undefined
  /**
   * The sweeper as the root arms it — wrapped there, inside the registry
   * call, because its own `stop` takes a cap on how long shutdown waits for
   * an in-flight pass (`FILE_GC_STOP_TIMEOUT_MS`), and handing the bare
   * method to a caller that passes no options would silently take the
   * sweeper's default instead.
   */
  fileGc: BackgroundWorker
}

function autoCheckpointWork(scheduler: () => CheckpointScheduler | undefined): BackgroundWork {
  return {
    name: 'auto-checkpoint',
    trigger: 'a document update, taken once that document has been quiet for five minutes',
    instances: {
      runs: 'every-instance',
      because:
        'the debounce is about documents THIS process is holding edits for — another ' +
        'instance has neither the pending timer nor the LoroDoc the checkpoint would be ' +
        'taken from, so a leader could not take it. A stdio process is one instance by ' +
        'construction.',
    },
    loop: LOOP_COSTS['auto-checkpoint'],
    // `start` makes the scheduler the one the agent write path signals
    // (`documentWritten`), which has no router in its call chain; the update
    // routes signal the same scheduler directly. After that the trigger
    // schedules itself from the write that signalled it.
    //
    // `stop` takes the pending checkpoints: a trailing debounce loses exactly
    // the checkpoint it exists to take, the one at the pause where editing
    // stopped, if the process goes away without flushing. It does NOT
    // uninstall — a write finishing after this point still arms a debounce
    // that a root's final flush then takes.
    worker: {
      start: () => {
        const current = scheduler()
        if (current !== undefined) installAutoCheckpoint(current)
      },
      stop: async () => {
        await scheduler()?.flush()
      },
    },
  }
}

function autoCompactWork(): BackgroundWork {
  return {
    name: 'auto-compact',
    trigger: 'a document write, folded once that workspace has been quiet for thirty seconds',
    instances: {
      runs: 'every-instance',
      because:
        'the debounce is about writes THIS process saw, and a leader could not know which ' +
        "those were. Two instances folding one record is covered by ADR-0020's generation " +
        "fence: the second fold is refused ('raced') and costs a compaction, never an edit.",
    },
    loop: LOOP_COSTS['auto-compact'],
    // `start` subscribes to saves; each save then arms its own debounce. The
    // agent write path schedules through `documentWritten` and so does not
    // depend on it. `stop` cancels the pending debounces and waits for a fold
    // already running, so shutdown never closes the database under one.
    worker: {
      start: () => installAutoCompact(new FileVersionStore()),
      stop: async () => {
        uninstallAutoCompact()
        await disposeAutoCompact()
      },
    },
  }
}

/** The declarations both roots run, each answering the registry's three questions once. */
export function sharedBackgroundWork(
  workers: SharedWorkers,
  arming: SharedWorkerArming,
): BackgroundWork[] {
  return [
    autoCheckpointWork(arming.checkpointScheduler),
    autoCompactWork(),
    {
      name: 'file-gc-sweeper',
      trigger: 'every WHITEBOARD_FILE_GC_INTERVAL_MS (24h by default); the sweeper resolves it',
      instances: {
        runs: 'every-instance',
        because:
          'ADR-0020 rejects a GC leader explicitly: it removes GC-versus-GC races and leaves ' +
          'GC-versus-WRITE untouched, since the write barrier is in-process and another ' +
          "instance's write never takes it. The grace period is what covers that window; " +
          'two passes racing the same file is the benign half — the second unlink answers ' +
          'ENOENT and is logged and skipped.',
      },
      loop: LOOP_COSTS['file-gc-sweeper'],
      worker: arming.fileGc,
    },
    {
      name: 'workspace-tail',
      trigger:
        workers.workspaceTailIntervalMs === null
          ? 'off (WHITEBOARD_WORKSPACE_TAIL_MS unset)'
          : `every ${workers.workspaceTailIntervalMs}ms`,
      instances: {
        runs: 'every-instance',
        because:
          'each instance is catching ITS OWN cached documents up with what another instance ' +
          'wrote; a leader doing it would leave every follower serving stale reads',
      },
      loop: LOOP_COSTS['workspace-tail'],
      worker: workers.workspaceTail,
    },
    {
      name: 'backup-scheduler',
      trigger: workers.backupTrigger,
      instances: { runs: 'leader-only', lease: 'backup' },
      loop: LOOP_COSTS['backup-scheduler'],
      worker: workers.backupScheduler,
    },
  ]
}

/**
 * What the stdio root runs: the published entry (`npx @kamiazya/whiteboard-mcp`).
 *
 * It mounts no router, so nothing else arms the automatic checkpoint, and
 * `compactWorkspace` declines `no-versions` until a history row exists — a
 * workspace only an agent edits through this entry would show no History and
 * grow its op-log without bound. The scheduler is the daemon's own, over the
 * same store, with no `onSaved`: no sync stream can be in this process.
 *
 * The compaction declaration is here for its stop: `documentWritten` already
 * schedules folds under stdio, and what that left unanswered was waiting out
 * a fold in flight before the process closes the database under it.
 */
export function stdioBackgroundWork(): BackgroundWork[] {
  const scheduler = createAutoVersionTrigger(new FileVersionStore())
  return [autoCheckpointWork(() => scheduler), autoCompactWork()]
}
