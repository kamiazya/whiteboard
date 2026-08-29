import { describe, expect, it } from 'vitest'
import {
  collectStorageEnvIssues,
  parseBackupDir,
  parseBackupIntervalMs,
  parseBackupKeep,
  parseFileGcGraceMs,
  parseFileGcIntervalMs,
  parseWorkspaceTailMs,
} from './storage-env.js'

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

  describe('parseBackupIntervalMs', () => {
    it('is absent when unset, so the caller supplies the default', () => {
      expect(parseBackupIntervalMs({})).toEqual({ ok: true, value: null })
    })

    it('takes a bare integer', () => {
      expect(parseBackupIntervalMs({ WHITEBOARD_BACKUP_INTERVAL_MS: '3600000' })).toEqual({
        ok: true,
        value: 3600000,
      })
    })

    it('refuses a unit suffix rather than reading its digits', () => {
      expect(parseBackupIntervalMs({ WHITEBOARD_BACKUP_INTERVAL_MS: '6h' }).ok).toBe(false)
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
    const issues = collectStorageEnvIssues(DATA_DIR, { WHITEBOARD_BACKUP_INTERVAL_MS: '3600000' })
    expect(issues).toContainEqual(
      expect.objectContaining({
        variable: 'WHITEBOARD_BACKUP_INTERVAL_MS',
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
        WHITEBOARD_BACKUP_INTERVAL_MS: '3600000',
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
