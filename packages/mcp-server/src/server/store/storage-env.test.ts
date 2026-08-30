import { Cron } from 'croner'
import { describe, expect, it } from 'vitest'
import {
  collectStorageEnvIssues,
  parseBackupDir,
  parseBackupKeep,
  parseBackupSchedule,
  parseFileGcGraceMs,
  parseFileGcIntervalMs,
  parseWorkspaceTailMs,
} from './storage-env.js'

/**
 * Node reads `TZ` from `process.env` on every `Intl` call, so the process
 * zone is settable from within a test — measured on Node 22, where setting it
 * mid-run changes `resolvedOptions().timeZone` immediately. Restored on the
 * way out, the unset case included, since a leftover zone would silently
 * re-date every later test in this file.
 */
function withProcessTz(tz: string, body: () => void): void {
  const before = process.env.TZ
  process.env.TZ = tz
  try {
    body()
  } finally {
    if (before === undefined) delete process.env.TZ
    else process.env.TZ = before
  }
}

const DATA_DIR = '/var/lib/whiteboard'

/**
 * The convention, stated once: **an unset setting takes its default; a SET
 * setting that cannot be understood aborts startup.**
 *
 * Setting a value is how an operator states a requirement. Silently running
 * on the default instead answers a requirement they expressed with behaviour
 * they did not ask for, and nothing anywhere says so — the operator believes
 * the retention window they configured is in force.
 *
 * This is not a new posture. `server/index.ts` already fails fast on a
 * malformed `WHITEBOARD_ALLOWED_WEB_ORIGINS` and a malformed OAuth client
 * registry, for the reason its own comment gives: a silent fallback "would
 * look identical to 'the operator never configured it'". The storage settings
 * were simply never held to it, and drifted into four different answers —
 * default, `Number.parseInt` prefix, off, and abort.
 */
describe('the storage-setting convention', () => {
  describe('unset takes the default', () => {
    it('has no issue when nothing is configured', () => {
      expect(collectStorageEnvIssues(DATA_DIR, {})).toEqual([])
    })

    it('treats an empty or whitespace value as unset, not as a mistake', () => {
      // Consistent with how the daemon already reads an empty
      // WHITEBOARD_DATABASE_AUTH_TOKEN: blank means "not configured".
      expect(
        collectStorageEnvIssues(DATA_DIR, {
          WHITEBOARD_FILE_GC_GRACE_MS: '',
          WHITEBOARD_WORKSPACE_TAIL_MS: '   ',
        }),
      ).toEqual([])
    })
  })

  describe('set but not understood is an issue', () => {
    it('rejects a unit suffix on every duration', () => {
      const issues = collectStorageEnvIssues(DATA_DIR, {
        WHITEBOARD_FILE_GC_INTERVAL_MS: '24h',
        WHITEBOARD_FILE_GC_GRACE_MS: '1h',
        WHITEBOARD_WORKSPACE_TAIL_MS: '2s',
      })
      expect(issues.map((issue) => issue.variable).sort()).toEqual([
        'WHITEBOARD_FILE_GC_GRACE_MS',
        'WHITEBOARD_FILE_GC_INTERVAL_MS',
        'WHITEBOARD_WORKSPACE_TAIL_MS',
      ])
    })

    /**
     * All of them, not the first. An operator fixing a misconfiguration one
     * restart at a time learns about one variable per attempt, which for a
     * container that takes minutes to come up is its own kind of unusable.
     */
    it('reports every bad variable in one pass', () => {
      const issues = collectStorageEnvIssues(DATA_DIR, {
        WHITEBOARD_FILE_GC_INTERVAL_MS: 'nope',
        WHITEBOARD_DATABASE_URL: 'postgres://db',
      })
      expect(issues).toHaveLength(2)
    })

    it('never echoes the offending value', () => {
      const issues = collectStorageEnvIssues(DATA_DIR, {
        WHITEBOARD_DATABASE_URL: 'libsql://user:hunter2@db.example.com',
      })
      const rendered = JSON.stringify(issues)
      expect(rendered).not.toContain('hunter2')
      expect(rendered).not.toContain('db.example.com')
    })
  })

  describe('meaningful values keep their meaning', () => {
    it('accepts zero, which is how both sweeps are turned off', () => {
      expect(
        collectStorageEnvIssues(DATA_DIR, {
          WHITEBOARD_FILE_GC_INTERVAL_MS: '0',
          WHITEBOARD_WORKSPACE_TAIL_MS: '0',
        }),
      ).toEqual([])
      expect(parseWorkspaceTailMs({ WHITEBOARD_WORKSPACE_TAIL_MS: '0' })).toEqual({
        ok: true,
        value: null,
      })
    })

    it('accepts a plain integer', () => {
      expect(parseFileGcIntervalMs({ WHITEBOARD_FILE_GC_INTERVAL_MS: '3600000' })).toEqual({
        ok: true,
        value: 3600000,
      })
      expect(parseFileGcGraceMs({ WHITEBOARD_FILE_GC_GRACE_MS: '60000' })).toEqual({
        ok: true,
        value: 60000,
      })
      expect(parseWorkspaceTailMs({ WHITEBOARD_WORKSPACE_TAIL_MS: '2000' })).toEqual({
        ok: true,
        value: 2000,
      })
    })

    it('accepts a database URL the daemon can open', () => {
      expect(
        collectStorageEnvIssues(DATA_DIR, {
          WHITEBOARD_DATABASE_URL: 'libsql://db.example.com',
        }),
      ).toEqual([])
    })
  })
})

/**
 * The scheduled-backup settings (ADR-0021 decision 4), designed as one group
 * rather than one environment variable at a time — which the ADR names as the
 * thing to avoid, because a surface assembled that way is the surface nobody
 * decided.
 *
 * They follow the same rule as every setting above: unset takes the default,
 * present-but-unintelligible aborts startup.
 */
describe('the scheduled-backup settings', () => {
  describe('parseBackupDir', () => {
    /**
     * Off unless a destination is set, because there is no destination worth
     * guessing. Writing copies next to the data they protect is not a backup,
     * and anywhere else is a path the operator has to choose.
     */
    it('is absent when nothing is configured', () => {
      expect(parseBackupDir({})).toEqual({ ok: true, value: null })
    })

    it('takes an absolute path', () => {
      expect(parseBackupDir({ WHITEBOARD_BACKUP_DIR: '/srv/backups' })).toEqual({
        ok: true,
        value: '/srv/backups',
      })
    })

    /**
     * A relative path resolves against the process's working directory, which
     * for a daemon is whatever the init system happened to pick. An operator
     * setting `./backups` means something specific and would not get it.
     */
    it('refuses a relative path rather than resolving it against the cwd', () => {
      const parsed = parseBackupDir({ WHITEBOARD_BACKUP_DIR: './backups' })
      expect(parsed.ok).toBe(false)
    })

    it('treats blank as unset', () => {
      expect(parseBackupDir({ WHITEBOARD_BACKUP_DIR: '   ' })).toEqual({ ok: true, value: null })
    })
  })

  describe('parseBackupSchedule', () => {
    /**
     * Cron rather than an interval, because an interval cannot say WHEN.
     * `every 24h` starts 24 hours after the daemon last restarted, which is
     * whenever the container happened to come up — so a backup lands in the
     * middle of the working day as easily as at night. A backup is expensive:
     * a database snapshot plus a copy of every blob. The operator has to be
     * able to put it in their own quiet window.
     */
    it('defaults to a nightly window rather than a start-relative interval', () => {
      const parsed = parseBackupSchedule({})
      expect(parsed.ok).toBe(true)
      if (!parsed.ok) return
      expect(parsed.value.expression).toBe('0 3 * * *')
    })

    /**
     * `TZ` is the POSIX standard and Node already honours it, so an operator
     * who has set it for the whole deployment — logs, timestamps, everything
     * — should not have to say it a second time here. Measured: with `TZ`
     * unset the schedule resolves in UTC; with `TZ=Asia/Tokyo` the same
     * expression fires at 18:00 UTC, which is 03:00 JST.
     *
     * The zone is RESOLVED rather than left implicit, because "3am in whose
     * zone" being invisible is the failure this setting exists to prevent —
     * the scheduler reports the zone it actually used, and it can only report
     * a zone that has a name.
     *
     * `Intl` rather than reading `TZ` directly: Windows has no such variable
     * and takes its zone from the OS, which is exactly the "can it be pulled
     * from an environment variable on every OS" question — it cannot, and
     * `Intl.DateTimeFormat().resolvedOptions().timeZone` is the portable
     * answer that reflects `TZ` where there is one.
     */
    it('falls back to the system zone rather than leaving it unstated', () => {
      withProcessTz('Asia/Tokyo', () => {
        const parsed = parseBackupSchedule({})
        expect(parsed).toEqual({
          ok: true,
          value: { expression: '0 3 * * *', timezone: 'Asia/Tokyo' },
        })
      })
    })

    it('lets the explicit setting override the system zone', () => {
      withProcessTz('Asia/Tokyo', () => {
        const parsed = parseBackupSchedule({ WHITEBOARD_BACKUP_TZ: 'Europe/Berlin' })
        expect(parsed.ok).toBe(true)
        if (!parsed.ok) return
        expect(parsed.value.timezone).toBe('Europe/Berlin')
      })
    })

    /**
     * A zone the operator did not choose must not abort their startup.
     *
     * Both of these are real: a blank `TZ` resolves through ICU to the
     * sentinel `Etc/Unknown`, which croner refuses outright, and a POSIX
     * offset like `JST-9` — which Node honours for every date it formats —
     * names no IANA zone at all, so `resolvedOptions().timeZone` comes back
     * `undefined`. Neither is a misconfiguration of THIS setting, so neither
     * is refused: the schedule falls back to `null`, which is the process's
     * own local time.
     */
    it('degrades to local time when the system zone has no usable name', () => {
      for (const tz of ['', 'JST-9']) {
        withProcessTz(tz, () => {
          expect(parseBackupSchedule({})).toEqual({
            ok: true,
            value: { expression: '0 3 * * *', timezone: null },
          })
        })
      }
    })

    /**
     * And `null` has to MEAN local time, not UTC — otherwise the fallback
     * above would silently move an operator's 3am. Under `TZ=JST-9` the
     * process is nine hours ahead, so `0 3 * * *` read with no zone must
     * land at 18:00 the previous day in UTC.
     */
    it('reads a null zone as the process own time, not as UTC', () => {
      withProcessTz('JST-9', () => {
        const parsed = parseBackupSchedule({})
        expect(parsed.ok).toBe(true)
        if (!parsed.ok) return
        const cron = new Cron(parsed.value.expression, { paused: true })
        const next = cron.nextRun(new Date('2026-03-04T00:00:00Z'))
        cron.stop()
        expect(next?.toISOString()).toBe('2026-03-04T18:00:00.000Z')
      })
    })

    it('takes an expression and a timezone', () => {
      expect(
        parseBackupSchedule({
          WHITEBOARD_BACKUP_CRON: '30 2 * * 0',
          WHITEBOARD_BACKUP_TZ: 'Asia/Tokyo',
        }),
      ).toEqual({ ok: true, value: { expression: '30 2 * * 0', timezone: 'Asia/Tokyo' } })
    })

    it('refuses an expression cron cannot parse', () => {
      expect(parseBackupSchedule({ WHITEBOARD_BACKUP_CRON: 'nightly please' }).ok).toBe(false)
    })

    /**
     * A schedule that parses but can never fire is the shape this whole area
     * exists to remove: configured, plausible-looking, and doing nothing. The
     * 30th of February parses fine.
     */
    it('refuses an expression that can never fire', () => {
      const parsed = parseBackupSchedule({ WHITEBOARD_BACKUP_CRON: '0 0 30 2 *' })
      expect(parsed.ok).toBe(false)
    })

    it('refuses a timezone that is not a real zone', () => {
      expect(parseBackupSchedule({ WHITEBOARD_BACKUP_TZ: 'Mars/Olympus_Mons' }).ok).toBe(false)
    })

    /** Never echo the value: a cron expression is not secret, but the rule is
     *  one rule for every setting rather than one judged per variable. */
    it('names the setting without quoting what was set', () => {
      const parsed = parseBackupSchedule({ WHITEBOARD_BACKUP_CRON: 'sekrit-looking' })
      expect(parsed.ok).toBe(false)
      if (parsed.ok) return
      expect(parsed.reason).not.toMatch(/sekrit-looking/)
    })
  })

  describe('parseBackupKeep', () => {
    it('is absent when unset', () => {
      expect(parseBackupKeep({})).toEqual({ ok: true, value: null })
    })

    it('takes a count', () => {
      expect(parseBackupKeep({ WHITEBOARD_BACKUP_KEEP: '14' })).toEqual({ ok: true, value: 14 })
    })

    /**
     * `0` would mean "take a backup, then immediately delete every backup",
     * which is a scheduled pass that does nothing but consume disk and IO. An
     * operator who wants that unsets the destination instead.
     */
    it('refuses zero, which would delete every backup it just took', () => {
      expect(parseBackupKeep({ WHITEBOARD_BACKUP_KEEP: '0' }).ok).toBe(false)
    })

    it('refuses a non-integer', () => {
      expect(parseBackupKeep({ WHITEBOARD_BACKUP_KEEP: '2.5' }).ok).toBe(false)
    })
  })

  /**
   * A destination is what arms the pass, so an interval or a retention count
   * WITHOUT one is a configuration that does nothing — and looks from the
   * outside exactly like one that works. Say so at startup rather than
   * silently ignoring them.
   */
  it('refuses an interval or a keep count with no destination to use them', () => {
    // The issue is reported ON the setting that has no effect, and its reason
    // names the one that would give it effect — so an operator reading the
    // startup line knows both which variable is inert and what to add.
    const issues = collectStorageEnvIssues(DATA_DIR, { WHITEBOARD_BACKUP_CRON: '0 3 * * *' })
    expect(issues).toContainEqual(
      expect.objectContaining({
        variable: 'WHITEBOARD_BACKUP_CRON',
        reason: expect.stringContaining('WHITEBOARD_BACKUP_DIR'),
      }),
    )

    const keepIssues = collectStorageEnvIssues(DATA_DIR, { WHITEBOARD_BACKUP_KEEP: '7' })
    expect(keepIssues).toContainEqual(
      expect.objectContaining({
        variable: 'WHITEBOARD_BACKUP_KEEP',
        reason: expect.stringContaining('WHITEBOARD_BACKUP_DIR'),
      }),
    )
  })

  it('accepts the three together', () => {
    expect(
      collectStorageEnvIssues(DATA_DIR, {
        WHITEBOARD_BACKUP_DIR: '/srv/backups',
        WHITEBOARD_BACKUP_CRON: '0 3 * * *',
        WHITEBOARD_BACKUP_KEEP: '7',
      }),
    ).toEqual([])
  })

  /** Never echo the value: a path can carry a username or a mount secret. */
  it('names the setting without quoting what was set', () => {
    const issues = collectStorageEnvIssues(DATA_DIR, {
      WHITEBOARD_BACKUP_DIR: './secret-looking-path',
    })
    expect(issues.length).toBeGreaterThan(0)
    for (const issue of issues) {
      expect(issue.reason).not.toMatch(/secret-looking-path/)
      expect(issue.variable).not.toMatch(/secret-looking-path/)
    }
  })
})
