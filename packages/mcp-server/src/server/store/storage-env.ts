import { isAbsolute } from 'node:path'
import { Cron } from 'croner'
import type { EnvIssue, ParsedSetting } from '../../shared/env-setting.js'
import { parseOptionalMilliseconds } from '../../shared/env-setting.js'
import { DB_URL_ENV, resolveDatabaseLocation } from './db/location.js'

/**
 * The storage and durability settings, held to the rule stated in
 * `shared/env-setting.ts`: an unset setting takes its default, a setting that
 * is present and cannot be understood aborts startup.
 *
 * This is not a new posture for this codebase — it is the one
 * `server/index.ts` already takes for `WHITEBOARD_ALLOWED_WEB_ORIGINS` and the
 * OAuth client registry, for the reason its own comment gives: a silent
 * fallback "would look identical to 'the operator never configured it'". The
 * storage settings were never held to it and had drifted into four different
 * answers for a malformed value — default, `Number.parseInt` prefix, off, and
 * abort.
 */

const FILE_GC_INTERVAL_ENV = 'WHITEBOARD_FILE_GC_INTERVAL_MS'
const FILE_GC_GRACE_ENV = 'WHITEBOARD_FILE_GC_GRACE_MS'
const WORKSPACE_TAIL_ENV = 'WHITEBOARD_WORKSPACE_TAIL_MS'
const BACKUP_DIR_ENV = 'WHITEBOARD_BACKUP_DIR'
const BACKUP_CRON_ENV = 'WHITEBOARD_BACKUP_CRON'
const BACKUP_TZ_ENV = 'WHITEBOARD_BACKUP_TZ'
const BACKUP_KEEP_ENV = 'WHITEBOARD_BACKUP_KEEP'

/** How often the file-GC sweeper runs. `0` disables it. */
export function parseFileGcIntervalMs(
  env: NodeJS.ProcessEnv = process.env,
): ParsedSetting<number | null> {
  return parseOptionalMilliseconds(env[FILE_GC_INTERVAL_ENV], null)
}

/** How old an unreferenced upload must be before a purge may delete it. */
export function parseFileGcGraceMs(
  env: NodeJS.ProcessEnv = process.env,
): ParsedSetting<number | null> {
  return parseOptionalMilliseconds(env[FILE_GC_GRACE_ENV], null)
}

/**
 * How often this instance follows the stored record, or `null` for "do not".
 *
 * `0` is an explicit off and stays meaningful — it is how an operator turns
 * following back off without removing the variable.
 */
export function parseWorkspaceTailMs(
  env: NodeJS.ProcessEnv = process.env,
): ParsedSetting<number | null> {
  const parsed = parseOptionalMilliseconds(env[WORKSPACE_TAIL_ENV], null)
  if (!parsed.ok) return parsed
  return { ok: true, value: parsed.value === 0 ? null : parsed.value }
}

/**
 * Where scheduled backups are written, or `null` for "do not take any".
 *
 * ADR-0021 decision 4 says a backup should be handled rather than remembered,
 * and this is the setting that arms it. It is nevertheless OFF by default,
 * because there is no destination worth guessing: writing copies beside the
 * data they protect is not a backup, and anywhere else is a path only the
 * operator knows.
 *
 * Absolute only. A relative path resolves against the process's working
 * directory, which for a daemon is whatever the init system happened to pick
 * — so `./backups` would mean something specific to the operator and land
 * somewhere else.
 */
export function parseBackupDir(env: NodeJS.ProcessEnv = process.env): ParsedSetting<string | null> {
  const trimmed = env[BACKUP_DIR_ENV]?.trim()
  if (trimmed === undefined || trimmed === '') return { ok: true, value: null }
  if (!isAbsolute(trimmed)) {
    return {
      ok: false,
      reason:
        "must be an absolute path; a relative one resolves against the daemon's working directory",
    }
  }
  return { ok: true, value: trimmed }
}

/**
 * When scheduled backups run: a cron expression and the zone to read it in.
 *
 * Cron rather than an interval, because an interval cannot say WHEN. "Every
 * 24 hours" starts 24 hours after the daemon last restarted — whenever the
 * container happened to come up — so it lands in the middle of the working
 * day as readily as at night. A backup is a database snapshot plus a copy of
 * every blob, which is real load, and the operator is the only one who knows
 * their quiet window.
 *
 * The default is a nightly one rather than nothing, so that window is what an
 * operator gets without having to know to ask for it.
 *
 * An expression that cannot fire is refused as firmly as one that cannot
 * parse. `0 0 30 2 *` is valid cron and describes the 30th of February; a
 * scheduler armed with it is configured, plausible-looking, and permanently
 * idle — the exact shape this area exists to remove.
 */
export interface BackupSchedule {
  expression: string
  /** `null` means the host's own zone, which in a container is usually UTC. */
  timezone: string | null
}

export function parseBackupSchedule(
  env: NodeJS.ProcessEnv = process.env,
): ParsedSetting<BackupSchedule> {
  const expression = env[BACKUP_CRON_ENV]?.trim() || '0 3 * * *'
  const timezone = env[BACKUP_TZ_ENV]?.trim() || null

  let next: Date | null
  try {
    // Constructed paused and stopped immediately: this is a validity check,
    // not a scheduler. The daemon keeps its own timer loop.
    const probe = new Cron(expression, { ...(timezone ? { timezone } : {}), paused: true })
    next = probe.nextRun()
    probe.stop()
  } catch {
    // The thrown message quotes the value, so it is not reused here.
    return {
      ok: false,
      reason: `must be a 5- or 6-field cron expression${timezone ? ', and the timezone must be a real IANA zone' : ''}`,
    }
  }
  if (next === null) {
    return {
      ok: false,
      reason: 'describes a time that can never occur, so no backup would ever run',
    }
  }
  return { ok: true, value: { expression, timezone } }
}

/**
 * How many scheduled backups to keep. `null` leaves the caller's default.
 *
 * `0` is refused rather than treated as "off": it would mean taking a backup
 * and then deleting every backup including the one just taken, which is a
 * pass that does nothing but spend disk and IO. Unsetting the destination is
 * how an operator turns this off.
 */
export function parseBackupKeep(
  env: NodeJS.ProcessEnv = process.env,
): ParsedSetting<number | null> {
  const trimmed = env[BACKUP_KEEP_ENV]?.trim()
  if (trimmed === undefined || trimmed === '') return { ok: true, value: null }
  if (!/^\d+$/.test(trimmed)) return { ok: false, reason: 'must be a whole number of backups' }
  const parsed = Number(trimmed)
  if (parsed === 0) {
    return {
      ok: false,
      reason: 'must keep at least one backup; unset the destination to turn scheduled backups off',
    }
  }
  if (!Number.isSafeInteger(parsed)) return { ok: false, reason: 'is too large to be a count' }
  return { ok: true, value: parsed }
}

/**
 * Every storage setting this process cannot honour, in one pass.
 *
 * All of them rather than the first: an operator fixing a misconfiguration
 * one restart at a time learns about one variable per attempt, which for a
 * container that takes minutes to come up is its own kind of unusable.
 */
export function collectStorageEnvIssues(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): EnvIssue[] {
  const issues: EnvIssue[] = []

  for (const [variable, parse] of [
    [FILE_GC_INTERVAL_ENV, parseFileGcIntervalMs],
    [FILE_GC_GRACE_ENV, parseFileGcGraceMs],
    [WORKSPACE_TAIL_ENV, parseWorkspaceTailMs],
    [BACKUP_DIR_ENV, parseBackupDir],
    [BACKUP_CRON_ENV, parseBackupSchedule],
    [BACKUP_KEEP_ENV, parseBackupKeep],
  ] as const) {
    const parsed = parse(env)
    if (!parsed.ok) issues.push({ variable, reason: parsed.reason })
  }

  // A destination is what arms the pass, so an interval or a retention count
  // without one configures nothing — and looks from the outside exactly like
  // a configuration that works. That is the shape this whole area exists to
  // remove, so it is said at startup rather than ignored.
  const destination = parseBackupDir(env)
  if (destination.ok && destination.value === null) {
    for (const variable of [BACKUP_CRON_ENV, BACKUP_TZ_ENV, BACKUP_KEEP_ENV]) {
      if ((env[variable]?.trim() ?? '') !== '') {
        issues.push({
          variable,
          reason: `has no effect without ${BACKUP_DIR_ENV}, which is what turns scheduled backups on`,
        })
      }
    }
  }

  // The database URL already aborts by throwing from wherever it is first
  // opened. Collecting it here moves that failure to startup alongside the
  // others, so an operator with two bad settings is told about both.
  try {
    resolveDatabaseLocation(dataDir, env)
  } catch {
    // The thrown message names the variable and its constraint; it is not
    // reused here because it is built from the value in some branches.
    issues.push({
      variable: DB_URL_ENV,
      reason: 'must be a libsql:, https:, file:, or loopback http: URL',
    })
  }

  return issues
}
