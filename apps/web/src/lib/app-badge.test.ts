// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { stubAppBadge } from '../test-utils/app-badge.js'
import { updateAppBadge } from './app-badge.js'
import { type ConnectionState, isNotKeeping, type SessionHealth } from './connection-state.js'
import type { ReplicaSaveHealth } from './replica-save-queue.js'
import type { StorageHealth } from './storage-health.js'

let badge: ReturnType<typeof stubAppBadge> | undefined
afterEach(() => badge?.restore())

describe('updateAppBadge', () => {
  // Every arm of every keeper, written out rather than read off
  // `isNotKeeping`, so the table is a claim of its own: the badge asks for
  // the user's return whenever what they typed is in this tab and nowhere
  // else — whoever keeps the workspace — and while a browser edit is stuck
  // unsaved, which also asks them not to leave yet.
  const SHOWN = {
    browser: { ok: false, stuck: true, failed: true },
    daemon: { synced: false, reconnecting: false, 'sync-off': true, 'write-failed': true },
    replica: { ok: false, failed: true },
  } as const satisfies {
    browser: Record<StorageHealth, boolean>
    daemon: Record<SessionHealth, boolean>
    replica: Record<ReplicaSaveHealth, boolean>
  } & Record<ConnectionState['keeper'], unknown>

  const cases: [ConnectionState, boolean][] = [
    ...Object.entries(SHOWN.browser).map(([storage, shown]): [ConnectionState, boolean] => [
      { keeper: 'browser', storage: storage as StorageHealth },
      shown,
    ]),
    ...Object.entries(SHOWN.daemon).map(([session, shown]): [ConnectionState, boolean] => [
      { keeper: 'daemon', session: session as SessionHealth },
      shown,
    ]),
    ...Object.entries(SHOWN.replica).map(([storage, shown]): [ConnectionState, boolean] => [
      { keeper: 'replica', storage: storage as ReplicaSaveHealth },
      shown,
    ]),
  ]

  it.each(
    cases.map(([state, shown]) => [JSON.stringify(state), state, shown] as const),
  )('%s sets the badge when the user is asked to return', (_label, state, shown) => {
    badge = stubAppBadge()
    updateAppBadge(state)
    expect(badge.set).toHaveBeenCalledTimes(shown ? 1 : 0)
    expect(badge.clear).toHaveBeenCalledTimes(shown ? 0 : 1)
    if (isNotKeeping(state)) expect(shown).toBe(true)
  })

  it('is a no-op where the Badging API is unavailable', () => {
    expect(() => updateAppBadge({ keeper: 'browser', storage: 'failed' })).not.toThrow()
  })
})
