import { describe, expect, it } from 'vitest'
import { collectStartupEnvIssues } from './startup-env.js'

const DATA_DIR = '/var/lib/whiteboard'

/**
 * The convention, now covering every setting a startup path reads rather than
 * the storage family alone.
 *
 * **An unset setting takes its default; a setting that is present and cannot
 * be understood aborts startup.** Setting a value is how an operator states a
 * requirement, and starting on the default answers it with behaviour they did
 * not ask for while saying so nowhere.
 *
 * `WHITEBOARD_LOG_LEVEL` is the case that shows why this is not only about
 * data. A misspelling silently became `warning`, so the operator who set
 * `debug` to investigate an incident got no debug output and no reason —
 * which is the shape of the problem at the worst possible moment.
 */
describe('collectStartupEnvIssues', () => {
  it('has no issue when nothing is configured', () => {
    expect(collectStartupEnvIssues(DATA_DIR, {})).toEqual([])
  })

  it('still reports the storage family', () => {
    const issues = collectStartupEnvIssues(DATA_DIR, { WHITEBOARD_FILE_GC_GRACE_MS: '1h' })
    expect(issues.map((issue) => issue.variable)).toEqual(['WHITEBOARD_FILE_GC_GRACE_MS'])
  })

  describe('WHITEBOARD_LOG_LEVEL', () => {
    it('rejects a level that is not one of the RFC 5424 names', () => {
      for (const raw of ['verbose', 'trace', 'warnings', 'warning!']) {
        const issues = collectStartupEnvIssues(DATA_DIR, { WHITEBOARD_LOG_LEVEL: raw })
        expect(
          issues.map((issue) => issue.variable),
          `${raw} should be rejected`,
        ).toEqual(['WHITEBOARD_LOG_LEVEL'])
      }
    })

    it('accepts every level the logger actually supports', () => {
      for (const raw of [
        'debug',
        'info',
        'notice',
        'warning',
        'error',
        'critical',
        'alert',
        'emergency',
      ]) {
        expect(collectStartupEnvIssues(DATA_DIR, { WHITEBOARD_LOG_LEVEL: raw })).toEqual([])
      }
    })

    /**
     * `warn`, mixed case and surrounding whitespace were already accepted, and
     * this gate must not narrow what the logger takes — it exists to reject
     * what the logger would silently DROP, not to add a second, stricter
     * opinion. `'INFO '` is here rather than in the rejected list above
     * because it was written there first and the gate correctly disagreed.
     */
    it('accepts what the logger already tolerates', () => {
      for (const raw of ['warn', 'WARNING', 'Debug', 'INFO ']) {
        expect(collectStartupEnvIssues(DATA_DIR, { WHITEBOARD_LOG_LEVEL: raw })).toEqual([])
      }
    })

    it('treats blank as unset', () => {
      expect(collectStartupEnvIssues(DATA_DIR, { WHITEBOARD_LOG_LEVEL: '  ' })).toEqual([])
    })

    it('never echoes the offending value', () => {
      const issues = collectStartupEnvIssues(DATA_DIR, { WHITEBOARD_LOG_LEVEL: 'sekrit-level' })
      expect(JSON.stringify(issues)).not.toContain('sekrit-level')
    })
  })

  it('reports every family in one pass', () => {
    const issues = collectStartupEnvIssues(DATA_DIR, {
      WHITEBOARD_LOG_LEVEL: 'verbose',
      WHITEBOARD_WORKSPACE_TAIL_MS: '2s',
      WHITEBOARD_DATABASE_URL: 'postgres://db',
    })
    expect(issues).toHaveLength(3)
  })
})
