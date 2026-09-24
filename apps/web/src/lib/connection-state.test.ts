import { describe, expect, it } from 'vitest'
import { isNotKeeping, notKeepingAnnouncement, sessionHealthOf } from './connection-state.js'

describe('the daemon session a page reports', () => {
  it.each([
    [true, 'connected', 'sync-off'],
    [false, 'connected', 'synced'],
    [false, 'reconnecting', 'reconnecting'],
    [false, 'idle', 'reconnecting'],
    // A write the keeper did not take is the session's error: the transport
    // may be up, so calling it reconnecting would send someone to look at
    // their network over an edit that is simply not stored yet.
    [false, 'error', 'write-failed'],
  ] as const)('authError=%s, status=%s is %s', (authError, status, health) => {
    expect(sessionHealthOf(authError, status)).toBe(health)
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
