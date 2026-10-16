import { afterEach, describe, expect, it } from 'vitest'
import type { BrowserPersistenceState } from './browser-persistence-state.js'
import {
  asksForReturn,
  type ConnectionState,
  isNotKeeping,
  notKeepingAnnouncement,
  type SessionHealth,
  sessionHealthOf,
} from './connection-state.js'
import { nothingHeldInTab } from './nothing-held-in-tab.js'
import type { ReplicaSaveHealth } from './replica-save-queue.js'
import { resetShellStatusForTests, setShellConnection } from './shell-status-store.js'
import type { StorageHealth } from './storage-health.js'

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
  // A withdrawn membership builds no session, so its status never leaves
  // `idle` — which would otherwise read as a reconnect nothing is making.
  it('reads a withdrawn membership as sync-off', () => {
    expect(sessionHealthOf(false, 'idle', SAVED, true)).toBe('sync-off')
  })
})

describe('a keeper that is not keeping', () => {
  it('includes a daemon write that has not landed', () => {
    expect(isNotKeeping({ keeper: 'daemon', session: 'write-failed' })).toBe(true)
    expect(isNotKeeping({ keeper: 'daemon', session: 'reconnecting' })).toBe(false)
  })

  // The offline replica page's copy is the only one of its edits while the
  // daemon is away, so a refused append there is the same condition.
  it('includes a refused write to the offline replica copy', () => {
    expect(isNotKeeping({ keeper: 'replica', storage: 'failed' })).toBe(true)
    expect(isNotKeeping({ keeper: 'replica', storage: 'ok' })).toBe(false)
    expect(notKeepingAnnouncement({ keeper: 'replica', storage: 'failed' })).toBe(
      'Writing to this browser failed',
    )
    expect(notKeepingAnnouncement({ keeper: 'replica', storage: 'ok' })).toBe('')
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

// Every tab-wide signal that answers "is the user's work held only here?",
// side by side over every arm of every keeper. Each column is read through
// the predicate its consumer calls, so a consumer that grows a rule of its
// own disagrees with a row someone wrote down rather than drifting unseen.
//   mark   — the broken shell mark (`isNotKeeping`)
//   badge  — the installed app's badge (`asksForReturn`)
//   reload — a waiting update is held rather than applied (`nothingHeldInTab`)
//   leave  — the browser asks before the tab goes (`asksForReturn`)
// A stuck browser edit asks the person to come back and not to leave, but
// does not hold a reload: reloading is what its own panel advises.
describe('the tab-wide signals over every connection state', () => {
  type Row = { mark: boolean; badge: boolean; reload: boolean; leave: boolean }
  const NONE: Row = { mark: false, badge: false, reload: false, leave: false }
  const HELD: Row = { mark: true, badge: true, reload: true, leave: true }
  const SIGNALS = {
    browser: { ok: NONE, stuck: { ...NONE, badge: true, leave: true }, failed: HELD },
    daemon: { synced: NONE, reconnecting: NONE, 'sync-off': HELD, 'write-failed': HELD },
    replica: { ok: NONE, failed: HELD },
  } as const satisfies {
    browser: Record<StorageHealth, Row>
    daemon: Record<SessionHealth, Row>
    replica: Record<ReplicaSaveHealth, Row>
  } & Record<ConnectionState['keeper'], unknown>

  const rows: [ConnectionState, Row][] = [
    ...Object.entries(SIGNALS.browser).map(([storage, row]): [ConnectionState, Row] => [
      { keeper: 'browser', storage: storage as StorageHealth },
      row,
    ]),
    ...Object.entries(SIGNALS.daemon).map(([session, row]): [ConnectionState, Row] => [
      { keeper: 'daemon', session: session as SessionHealth },
      row,
    ]),
    ...Object.entries(SIGNALS.replica).map(([storage, row]): [ConnectionState, Row] => [
      { keeper: 'replica', storage: storage as ReplicaSaveHealth },
      row,
    ]),
  ]

  afterEach(() => resetShellStatusForTests())

  it.each(
    rows.map(([state, row]) => [JSON.stringify(state), state, row] as const),
  )('%s', (_label, state, row) => {
    setShellConnection({ state })
    expect({
      mark: isNotKeeping(state),
      badge: asksForReturn(state),
      reload: !nothingHeldInTab(),
      leave: asksForReturn(state),
    }).toEqual(row)
  })
})
