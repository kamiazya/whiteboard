import { describe, expect, it } from 'vitest'
import type { BrowserPersistenceState } from './browser-persistence-state.js'
import { isNotKeeping, notKeepingAnnouncement, sessionHealthOf } from './connection-state.js'

const SAVED: BrowserPersistenceState = { kind: 'saved', lastSavedAt: null }
const FAILED: BrowserPersistenceState = {
  kind: 'degraded',
  reason: 'write-failed',
  message: 'The last write failed.',
  lastSavedAt: null,
}

describe('the daemon session a page reports', () => {
  it.each([
    [true, 'connected', false, 'sync-off'],
    [true, 'connected', true, 'sync-off'],
    [false, 'connected', false, 'synced'],
    [false, 'reconnecting', false, 'reconnecting'],
    [false, 'idle', false, 'reconnecting'],
    // The session's error is not only a write: an unreadable document or a
    // backend failure report it too, and those are not "not saved".
    [false, 'error', false, 'reconnecting'],
    // A write the keeper did not take, whatever the transport is doing: it may
    // be up, so calling it reconnecting would send someone to look at their
    // network over an edit that is simply not stored yet.
    [false, 'connected', true, 'write-failed'],
    [false, 'error', true, 'write-failed'],
  ] as const)('authError=%s, status=%s, writeFailed=%s is %s', (authError, status, writeFailed, health) => {
    expect(sessionHealthOf(authError, status, writeFailed ? FAILED : SAVED)).toBe(health)
  })
})

describe('a keeper that is not keeping', () => {
  it('includes a daemon write that has not landed', () => {
    expect(isNotKeeping({ keeper: 'daemon', session: 'write-failed' })).toBe(true)
    expect(isNotKeeping({ keeper: 'daemon', session: 'reconnecting' })).toBe(false)
  })

  it('is announced in words about its own keeper', () => {
    expect(notKeepingAnnouncement({ keeper: 'browser', storage: 'failed' })).toBe(
      'Writing to this browser failed',
    )
    expect(notKeepingAnnouncement({ keeper: 'daemon', session: 'sync-off' })).toBe('Live sync off')
    expect(notKeepingAnnouncement({ keeper: 'daemon', session: 'write-failed' })).toBe(
      'Changes not saved yet',
    )
    expect(notKeepingAnnouncement({ keeper: 'daemon', session: 'synced' })).toBe('')
    expect(notKeepingAnnouncement(null)).toBe('')
  })
})
