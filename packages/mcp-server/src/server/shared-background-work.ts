import type { BackgroundWork, BackgroundWorker } from './background-work.js'
import { LOOP_COSTS } from './background-work-costs.js'
import { getDataDir } from './config.js'
import { subscribedWorkspaceIds } from './routes/sync-audience.js'
import { createBackupLease, createBackupScheduler } from './store/backup-scheduler.js'
import {
  cacheBackedWorkspaceDocs,
  emitWorkspaceDocUpdated,
  getWorkspaceDoc,
} from './store/document-store.js'
import { createFileGcSweeper, type FileGcSweeper } from './store/file-gc-sweeper.js'
import { parseBackupDir, parseBackupKeep, parseBackupSchedule } from './store/storage-env.js'
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
   * Takes the pending checkpoints. Read at STOP time rather than captured,
   * because the trigger is handed back by `createApp` after the workers are
   * built.
   */
  flushCheckpoints: () => Promise<void>
  /**
   * The sweeper as the root arms it — wrapped there, inside the registry
   * call, because its own `stop` takes a cap on how long shutdown waits for
   * an in-flight pass (`FILE_GC_STOP_TIMEOUT_MS`), and handing the bare
   * method to a caller that passes no options would silently take the
   * sweeper's default instead.
   */
  fileGc: BackgroundWorker
}

/** The four declarations, each answering the registry's three questions once. */
export function sharedBackgroundWork(
  workers: SharedWorkers,
  arming: SharedWorkerArming,
): BackgroundWork[] {
  return [
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
      worker: { start: () => {}, stop: arming.flushCheckpoints },
    },
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
