import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { ConnectionState } from '../../lib/connection-state.js'
import { resetShellStatusForTests, setShellConnection } from '../../lib/shell-status-store.js'
import { stubAppBadge } from '../../test-utils/app-badge.js'
import { KeeperNotices } from './KeeperNotices.js'

let badge: ReturnType<typeof stubAppBadge>
beforeEach(() => {
  badge = stubAppBadge()
})
afterEach(() => {
  cleanup()
  resetShellStatusForTests()
  badge.restore()
})

function publish(state: ConnectionState | null): void {
  act(() => setShellConnection(state === null ? null : { state }))
}

// The frame writes the badge from whatever page publishes to the shell, so a
// page that publishes a state gets the badge without wiring it itself.
it('sets the app badge while the published state asks for return, and clears it after', () => {
  render(<KeeperNotices />)
  publish({ keeper: 'daemon', session: 'synced' })
  expect(badge.set).not.toHaveBeenCalled()
  publish({ keeper: 'browser', storage: 'stuck' })
  expect(badge.set).toHaveBeenCalledTimes(1)
  publish({ keeper: 'browser', storage: 'ok' })
  expect(badge.clear).toHaveBeenCalledTimes(1)
})

it('clears a badge it set when the page goes, and when the frame does', () => {
  const { unmount } = render(<KeeperNotices />)
  publish({ keeper: 'replica', storage: 'failed' })
  publish(null)
  expect(badge.clear).toHaveBeenCalledTimes(1)

  publish({ keeper: 'daemon', session: 'write-failed' })
  unmount()
  expect(badge.clear).toHaveBeenCalledTimes(2)
})

// Another window of the app may have raised the badge; one that never set
// it has nothing of its own to take back.
it('leaves alone a badge this window never set', () => {
  const { unmount } = render(<KeeperNotices />)
  publish({ keeper: 'daemon', session: 'synced' })
  publish(null)
  unmount()
  expect(badge.clear).not.toHaveBeenCalled()
})

// Closing the window runs no React cleanup; `pagehide` is the last word it
// gets, and a back-forward cache restore brings the page and its ask back.
it('takes its badge back when the page is hidden, and raises it again on a restore', () => {
  render(<KeeperNotices />)
  publish({ keeper: 'daemon', session: 'sync-off' })
  act(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })))
  expect(badge.clear).toHaveBeenCalledTimes(1)
  act(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })))
  expect(badge.set).toHaveBeenCalledTimes(2)
})
