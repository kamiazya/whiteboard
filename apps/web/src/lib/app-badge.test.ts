// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { stubAppBadge } from '../test-utils/app-badge.js'
import { createAppBadgeWriter } from './app-badge.js'
import { type ConnectionState, isNotKeeping, type SessionHealth } from './connection-state.js'
import type { ReplicaSaveHealth } from './replica-save-queue.js'
import type { StorageHealth } from './storage-health.js'

const ASKS: ConnectionState = { keeper: 'daemon', session: 'write-failed' }
const SYNCED: ConnectionState = { keeper: 'daemon', session: 'synced' }

let badge: ReturnType<typeof stubAppBadge> | undefined
afterEach(() => badge?.restore())

describe('the app badge a window writes', () => {
  // Every arm of every keeper, written out rather than read off
  // `isNotKeeping`, so the table is a claim of its own: the badge asks for
  // the user's return whenever what they typed is in this tab and nowhere
  // else — whoever keeps the workspace — and while a browser edit is stuck
  // unsaved, which the leave prompt asks about too.
  const SHOWN = {
    browser: { ok: false, stuck: true, failed: true },
    daemon: {
      synced: false,
      reconnecting: false,
      'sync-off': true,
      'write-failed': true,
      // No session was built, so nothing typed can be waiting here.
      'not-opened': false,
    },
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
  )('%s: the badge is set exactly when the user is asked to return', (_label, state, shown) => {
    badge = stubAppBadge()
    createAppBadgeWriter().write(state)
    expect(badge.set).toHaveBeenCalledTimes(shown ? 1 : 0)
    // A window that never set the badge leaves it alone.
    expect(badge.clear).not.toHaveBeenCalled()
    if (isNotKeeping(state)) expect(shown).toBe(true)

    const raised = createAppBadgeWriter()
    raised.write(ASKS)
    raised.write(state)
    expect(badge.clear).toHaveBeenCalledTimes(shown ? 0 : 1)
  })

  // Every window of the installed app shares one badge, so two writers over
  // one navigator stand for two windows.
  it('is cleared only by the window that set it', () => {
    badge = stubAppBadge()
    const asking = createAppBadgeWriter()
    const healthy = createAppBadgeWriter()
    asking.write(ASKS)
    healthy.write(SYNCED)
    healthy.write({ keeper: 'browser', storage: 'ok' })
    healthy.write(null)
    expect(badge.set).toHaveBeenCalledTimes(1)
    expect(badge.clear).not.toHaveBeenCalled()

    asking.write(SYNCED)
    expect(badge.clear).toHaveBeenCalledTimes(1)
  })

  it('clears what it set once the window lets go of it', () => {
    badge = stubAppBadge()
    const writer = createAppBadgeWriter()
    writer.write(ASKS)
    writer.write(null)
    expect(badge.clear).toHaveBeenCalledTimes(1)
    writer.write(null)
    expect(badge.clear).toHaveBeenCalledTimes(1)
  })

  // A spy records how its promise settles, which handles the rejection
  // itself; only a plain function shows whether the writer lets one escape.
  it('swallows a Badging API that rejects', async () => {
    const escaped: unknown[] = []
    const record = (reason: unknown) => escaped.push(reason)
    process.on('unhandledRejection', record)
    const refuse = () => Promise.reject(new DOMException('badging not allowed', 'NotAllowedError'))
    Object.defineProperty(navigator, 'setAppBadge', { value: refuse, configurable: true })
    Object.defineProperty(navigator, 'clearAppBadge', { value: refuse, configurable: true })
    try {
      const writer = createAppBadgeWriter()
      writer.write(ASKS)
      writer.write(SYNCED)
      // Node reports an unhandled rejection once the microtasks drain, before
      // the next check phase.
      await new Promise((resolve) => setImmediate(resolve))
    } finally {
      Reflect.deleteProperty(navigator, 'setAppBadge')
      Reflect.deleteProperty(navigator, 'clearAppBadge')
      process.off('unhandledRejection', record)
    }
    expect(escaped).toEqual([])
  })

  it('puts back a Badging API the stub shadowed when it restores', () => {
    const original = () => Promise.resolve()
    Object.defineProperty(navigator, 'setAppBadge', { value: original, configurable: true })
    try {
      stubAppBadge().restore()
      expect(navigator.setAppBadge).toBe(original)
    } finally {
      Reflect.deleteProperty(navigator, 'setAppBadge')
    }
  })

  it('is a no-op where the Badging API is unavailable', () => {
    const writer = createAppBadgeWriter()
    expect(() => writer.write({ keeper: 'browser', storage: 'failed' })).not.toThrow()
    expect(() => writer.write(null)).not.toThrow()
  })
})
