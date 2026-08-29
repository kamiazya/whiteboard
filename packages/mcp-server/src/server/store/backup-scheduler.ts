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
import { getLogger } from '../log.js'
import type { ServerBackupOutcome } from './backup-pass.js'
import { performBackup } from './backup-pass.js'

const log = getLogger('backup-scheduler')

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000
const DEFAULT_KEEP = 7

// setTimeout only supports delays up to a signed 32-bit int and silently
// truncates anything larger to 1ms, which would turn "run monthly" into a
// near-continuous backup loop. Same clamp, same reason, as file-gc-sweeper.
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
  intervalMs?: number
  keep?: number
  now?: () => Date
  runBackup?: (dataDir: string, outputDir: string) => Promise<ServerBackupOutcome>
}

export interface BackupScheduler {
  start(): void
  stop(): Promise<void>
  /** Run one pass now, awaiting it. Used by tests and by a manual trigger. */
  runOnceForTests(): Promise<void>
}

export function createBackupScheduler(options: BackupSchedulerOptions): BackupScheduler {
  const { dataDir, backupDir } = options
  const intervalMs = Math.min(options.intervalMs ?? DEFAULT_INTERVAL_MS, MAX_TIMER_DELAY_MS)
  const keep = options.keep ?? DEFAULT_KEEP
  const now = options.now ?? (() => new Date())
  const runBackup =
    options.runBackup ??
    ((src: string, dest: string) => performBackup({ dataDir: src, outputDir: dest }))

  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight: Promise<void> | null = null
  let stopped = false

  async function runPass(): Promise<void> {
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

  function scheduleNext(): void {
    if (stopped || backupDir === null || intervalMs <= 0) return
    timer = setTimeout(() => {
      timer = null
      void tick()
    }, intervalMs)
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
  }
}
