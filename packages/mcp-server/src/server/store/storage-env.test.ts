import { describe, expect, it } from 'vitest'
import {
  collectStorageEnvIssues,
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
