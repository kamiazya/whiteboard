// Periodic backup of the data directory (ADR-0021 decision 4).
//
// "What an operator wants is not a command they must remember to run. It is
// for this to be handled." So the schedule is the mechanism and
// `whiteboard server backup` is a manual trigger of the same pass — this
// module owns only WHEN and WHERE, and `performBackup` owns the backup.
//
// The timer is the shape `file-gc-sweeper` already uses, for its reasons: a
// completion-rescheduled unref'd ONE-SHOT, never `setInterval`. A pass that
// outruns its own interval must not stack, and a background timer must not
// hold the daemon's event loop open when it is otherwise idle.
//
// None of this was possible before decision 3. A backup that required
// stopping the server could not be scheduled at all.

import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Cron } from 'croner'
import { getLogger } from '../log.js'
import type { ServerBackupOutcome } from './backup-pass.js'
import { performBackup } from './backup-pass.js'
import type { Database } from './db/index.js'
import { getDb } from './db/index.js'
import type { LeaseOutcome } from './lease.js'
import { withLease } from './lease.js'
import type { BackupSchedule } from './storage-env.js'

const log = getLogger('backup-scheduler')

const DEFAULT_KEEP = 7
const DEFAULT_SCHEDULE: BackupSchedule = { expression: '0 3 * * *', timezone: null }

// setTimeout only supports delays up to a signed 32-bit int and silently
// truncates anything larger to 1ms, which would turn a monthly schedule into
// a near-continuous backup loop. Same clamp, same reason, as
// file-gc-sweeper — and reachable here, since a cron expression can name a
// date more than 24.8 days out. The pass simply re-arms when it wakes and
// finds the target still ahead.
const MAX_TIMER_DELAY_MS = 2_147_483_647

/**
 * A directory this scheduler wrote, by name.
 *
 * Retention counts BACKUPS, not directory entries: an operator's own notes
 * file sitting beside them must neither be deleted nor push a real backup out
 * of the window. The name is the timestamp with `:` replaced, so it is
 * filesystem-safe on every platform and still sorts chronologically — which
 * is what lets retention order by name rather than by mtime, a field a copy
 * or a restore can rewrite.
 */
const BACKUP_DIR_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/

function backupDirName(at: Date): string {
  return at.toISOString().replace(/:/g, '-')
}

export interface BackupSchedulerOptions {
  dataDir: string
  /** `null` disables the scheduler entirely — see `parseBackupDir`. */
  backupDir: string | null
  /** When to run. Cron, so the operator controls the hour, not just the gap. */
  schedule?: BackupSchedule
  keep?: number
  now?: () => Date
  runBackup?: (dataDir: string, outputDir: string) => Promise<ServerBackupOutcome>
  /**
   * Runs a pass only if this instance is the deployment's leader.
   *
   * Defaults to running it — a single daemon is trivially the leader, and a
   * deployment with no shared database has nothing to contend with. Wired to
   * `createBackupLease` by the composition root, which is what makes several
   * instances take one backup between them rather than one each.
   */
  runExclusively?: <T>(body: () => Promise<T>) => Promise<LeaseOutcome<T>>
}

export interface BackupLeaseOptions {
  /** This instance. The daemon's `instanceId`, minted once per process. */
  holder: string
  getDb?: () => Promise<Database>
}

/**
 * How long a pass may go unrenewed before another instance may take over.
 *
 * Generous, because the cost of it being too long is nil — the next attempt
 * is the next cron fire, hours away — while the cost of it being too short is
 * two instances backing up at once, which is the thing being prevented. The
 * lease is renewed at a third of this for as long as the pass runs, so the
 * duration of a pass does not enter into it.
 */
const BACKUP_LEASE_TTL_MS = 5 * 60_000

const BACKUP_LEASE_NAME = 'backup'

export function createBackupLease(
  options: BackupLeaseOptions,
): <T>(body: () => Promise<T>) => Promise<LeaseOutcome<T>> {
  const resolveDb = options.getDb ?? (() => getDb())
  return async <T>(body: () => Promise<T>) => {
    const db = await resolveDb()
    return withLease(
      db,
      { name: BACKUP_LEASE_NAME, holder: options.holder, ttlMs: BACKUP_LEASE_TTL_MS },
      body,
    )
  }
}

export interface BackupScheduler {
  start(): void
  stop(): Promise<void>
  /** Run one pass now, awaiting it. Used by tests and by a manual trigger. */
  runOnceForTests(): Promise<void>
  /** The next time the schedule fires, or `null` if it never will. */
  nextRunForTests(): Date | null
}

export function createBackupScheduler(options: BackupSchedulerOptions): BackupScheduler {
  const { dataDir, backupDir } = options
  const schedule = options.schedule ?? DEFAULT_SCHEDULE
  const keep = options.keep ?? DEFAULT_KEEP
  const now = options.now ?? (() => new Date())
  const runBackup =
    options.runBackup ??
    ((src: string, dest: string) => performBackup({ dataDir: src, outputDir: dest }))
  const runExclusively =
    options.runExclusively ??
    (async <T>(body: () => Promise<T>) => ({ ok: true as const, value: await body() }))

  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight: Promise<void> | null = null
  let stopped = false

  async function runPass(): Promise<void> {
    if (backupDir === null) return
    // Fail CLOSED around leadership: an error here means this instance cannot
    // tell whether another is already backing up, and the answer to that is
    // not "back up anyway". A missed nightly pass on a deployment whose
    // shared store is unreachable costs one night; every instance running at
    // once precisely when that store is unwell costs more.
    let leased: LeaseOutcome<void>
    try {
      leased = await runExclusively(takeOneBackup)
    } catch (err) {
      log.error({ err }, 'could not establish which instance takes the backup; skipping this pass')
      return
    }
    if (!leased.ok) {
      // Not an error: on a multi-instance deployment this is what every
      // instance but one does, every night.
      log.info({}, 'another instance holds the backup lease; standing down')
    }
  }

  async function takeOneBackup(): Promise<void> {
    if (backupDir === null) return
    const outputDir = join(backupDir, backupDirName(now()))
    let outcome: ServerBackupOutcome
    try {
      await mkdir(backupDir, { recursive: true })
      outcome = await runBackup(dataDir, outputDir)
    } catch (err) {
      log.error({ err }, 'scheduled backup threw')
      return
    }
    if (outcome.kind !== 'ok') {
      // Reported, not thrown, and retention does NOT run: deleting on the way
      // to a backup that then failed is how an operator ends up with fewer
      // backups than before they configured this.
      log.error({ outcome: outcome.kind }, 'scheduled backup did not complete')
      return
    }
    // Inside the lease with the backup, not beside it: a follower that skipped
    // the pass but still pruned would be deleting on the strength of a count
    // it did not take.
    await pruneOldBackups(backupDir, keep)
  }

  async function pruneOldBackups(dir: string, keepCount: number): Promise<void> {
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch (err) {
      log.warning({ err }, 'could not list the backup directory to apply retention')
      return
    }
    // Newest first by name, which for this format is newest first by time.
    const ours = entries
      .filter((name) => BACKUP_DIR_NAME.test(name))
      .sort((a, b) => (a < b ? 1 : -1))
    for (const name of ours.slice(keepCount)) {
      try {
        await rm(join(dir, name), { recursive: true, force: true })
      } catch (err) {
        log.warning({ err }, 'could not remove an expired backup')
      }
    }
  }

  /**
   * croner is asked only for the next fire time; the loop stays ours.
   *
   * Its own scheduler would be a second answer to "is a pass already
   * running", and the no-overlap guard below is the one that is tested. This
   * also keeps the shape `file-gc-sweeper` established — a
   * completion-rescheduled unref'd one-shot.
   */
  function nextRun(from: Date): Date | null {
    const cron = new Cron(schedule.expression, {
      ...(schedule.timezone ? { timezone: schedule.timezone } : {}),
      paused: true,
    })
    try {
      return cron.nextRun(from)
    } finally {
      cron.stop()
    }
  }

  function scheduleNext(): void {
    if (stopped || backupDir === null) return
    const at = nextRun(now())
    if (at === null) {
      // Refused at startup by `parseBackupSchedule`, so this is only
      // reachable through a direct caller. Say so rather than arming a timer
      // that silently never fires.
      log.error({}, 'backup schedule can never fire; no backups will be taken')
      return
    }
    // Clamped, not skipped: a target further out than the timer maximum wakes
    // early, finds itself still ahead, and re-arms.
    const delay = Math.min(Math.max(0, at.getTime() - now().getTime()), MAX_TIMER_DELAY_MS)
    timer = setTimeout(() => {
      timer = null
      // Woke early because the target was beyond the timer maximum. Re-arm
      // rather than backing up ten months ahead of schedule.
      if (now().getTime() < at.getTime()) {
        scheduleNext()
        return
      }
      void tick()
    }, delay)
    timer.unref()
  }

  function tick(): Promise<void> {
    if (stopped) return Promise.resolve()
    // One at a time. A pass slower than its interval must not overlap itself:
    // two backups writing the same directory tree, and two retention passes
    // deciding what to delete from a set the other is changing.
    if (inFlight) return inFlight
    const pending = runPass()
      .catch((err) => {
        log.error({ err }, 'scheduled backup pass failed')
      })
      .finally(() => {
        inFlight = null
        scheduleNext()
      })
    inFlight = pending
    return pending
  }

  return {
    start(): void {
      if (backupDir === null) {
        log.info({}, 'scheduled backups are off: no destination configured')
        return
      }
      stopped = false
      scheduleNext()
      // Said once, at startup, because "3am in whose zone" is the question a
      // schedule silently gets wrong. The zone here is already RESOLVED —
      // the operator's setting, or the system's own — and the absolute
      // instant is what makes it checkable without arithmetic.
      log.info(
        {
          backupDir,
          schedule: schedule.expression,
          timezone: schedule.timezone,
          nextRun: nextRun(now())?.toISOString() ?? null,
          keep,
        },
        'scheduled backups are on',
      )
    },
    async stop(): Promise<void> {
      stopped = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (inFlight) await inFlight.catch(() => {})
    },
    runOnceForTests(): Promise<void> {
      return tick()
    },
    nextRunForTests(): Date | null {
      return nextRun(now())
    },
  }
}
