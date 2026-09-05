import { describe, expect, it } from 'vitest'
import type { BrowserPersistenceState } from './browser-persistence-state.js'
import { STUCK_AFTER_MS, storageHealthOf } from './storage-health.js'

const saved: BrowserPersistenceState = { kind: 'saved', lastSavedAt: '2026-09-05T10:32:00.000Z' }
const pending: BrowserPersistenceState = { kind: 'pending', lastSavedAt: null }
const saving: BrowserPersistenceState = { kind: 'saving', lastSavedAt: null }
const degraded: BrowserPersistenceState = {
  kind: 'degraded',
  reason: 'write-failed',
  message: 'The last write to this browser failed.',
  lastSavedAt: null,
}

describe('storageHealthOf', () => {
  it('a saved document is ok, whatever the clock says', () => {
    expect(storageHealthOf(saved, null, 0)).toBe('ok')
    expect(storageHealthOf(saved, 0, 999_999)).toBe('ok')
  })

  // The ordinary state while someone types: unsaved for a few hundred
  // milliseconds at a time. Not a condition, not shown.
  it('an edit that has been unsaved for less than the threshold is ok', () => {
    expect(storageHealthOf(pending, 1_000, 1_000 + STUCK_AFTER_MS - 1)).toBe('ok')
    expect(storageHealthOf(saving, 1_000, 1_000 + STUCK_AFTER_MS - 1)).toBe('ok')
  })

  it('an edit unsaved for the threshold or longer is stuck', () => {
    expect(storageHealthOf(pending, 1_000, 1_000 + STUCK_AFTER_MS)).toBe('stuck')
    expect(storageHealthOf(saving, 1_000, 1_000 + STUCK_AFTER_MS + 60_000)).toBe('stuck')
  })

  // A refusal is a condition from the moment it is known; there is nothing
  // to wait out.
  it('a refused write is failed at once', () => {
    expect(storageHealthOf(degraded, 1_000, 1_000)).toBe('failed')
    expect(storageHealthOf(degraded, null, 0)).toBe('failed')
  })

  // A pending state with no recorded start cannot be judged stuck — the
  // caller has not seen the transition, so the clock has nothing to count
  // from. Saying "stuck" here would fire on the first render of a page that
  // mounted mid-write.
  it('pending with no known start is ok', () => {
    expect(storageHealthOf(pending, null, 999_999)).toBe('ok')
  })
})
