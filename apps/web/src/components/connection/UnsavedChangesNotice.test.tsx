import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { ConnectionState } from '../../lib/connection-state.js'
import { resetShellStatusForTests, setShellConnection } from '../../lib/shell-status-store.js'
import { UnsavedChangesNotice } from './UnsavedChangesNotice.js'

const NOT_LANDED: ConnectionState = { keeper: 'daemon', session: 'write-failed' }
const SYNCED: ConnectionState = { keeper: 'daemon', session: 'synced' }

afterEach(() => {
  cleanup()
  resetShellStatusForTests()
})

/** What a page holding a live session publishes to the shell. */
function publish(state: ConnectionState | null): void {
  act(() => setShellConnection(state === null ? null : { state }))
}

function leaving(): Event {
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  return event
}

it('says in plain sight that changes have not reached the daemon', () => {
  publish(NOT_LANDED)
  render(<UnsavedChangesNotice />)
  expect(screen.getByText(/Changes not saved yet/)).toBeTruthy()
  expect(screen.getByText(/keep this tab open/i)).toBeTruthy()
})

it('asks before the tab is closed while changes are held only in it', () => {
  publish(NOT_LANDED)
  render(<UnsavedChangesNotice />)
  expect(leaving().defaultPrevented).toBe(true)

  publish(SYNCED)
  expect(leaving().defaultPrevented).toBe(false)
})

it('can be dismissed, and comes back the next time changes stop landing', () => {
  publish(NOT_LANDED)
  render(<UnsavedChangesNotice />)
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
  expect(screen.queryByText(/Changes not saved yet/)).toBeNull()
  // Dismissing hides the words, not the protection.
  expect(leaving().defaultPrevented).toBe(true)

  publish(SYNCED)
  publish(NOT_LANDED)
  expect(screen.getByText(/Changes not saved yet/)).toBeTruthy()
})

it('says nothing for a synced page, a browser-kept one, or no session', () => {
  publish(SYNCED)
  render(<UnsavedChangesNotice />)
  expect(screen.queryByText(/Changes not saved yet/)).toBeNull()
  publish({ keeper: 'browser', storage: 'ok' })
  expect(screen.queryByText(/Changes not saved yet/)).toBeNull()
  publish(null)
  expect(leaving().defaultPrevented).toBe(false)
})

// The replica page states its own refused write, with the retry beside it,
// so this notice adds only what that page cannot: the leave prompt.
it('asks before leaving an offline replica whose copy refused a write, without a second banner', () => {
  publish({ keeper: 'replica', storage: 'failed' })
  render(<UnsavedChangesNotice />)
  expect(leaving().defaultPrevented).toBe(true)
  expect(screen.queryByText(/Changes not saved yet/)).toBeNull()

  publish({ keeper: 'replica', storage: 'ok' })
  expect(leaving().defaultPrevented).toBe(false)
})

// The browser panel tells the person to export before closing the tab; the
// prompt is what backs that sentence. The words stay daemon-only.
it('asks before leaving a browser-kept page whose storage refused a write, without a second banner', () => {
  publish({ keeper: 'browser', storage: 'failed' })
  render(<UnsavedChangesNotice />)
  expect(leaving().defaultPrevented).toBe(true)
  expect(screen.queryByText(/Changes not saved yet/)).toBeNull()

  publish({ keeper: 'browser', storage: 'ok' })
  expect(leaving().defaultPrevented).toBe(false)
})

// The prompt asks exactly when the app badge does: a refused session holds
// whatever was typed since in this tab alone, and a stuck browser edit is
// not stored yet. Each states itself elsewhere, so neither gets the banner.
it.each([
  ['a daemon session that is off', { keeper: 'daemon', session: 'sync-off' }],
  ['a browser edit that is stuck unsaved', { keeper: 'browser', storage: 'stuck' }],
] as const)('asks before leaving %s, without a banner', (_label, state) => {
  publish(state)
  render(<UnsavedChangesNotice />)
  expect(leaving().defaultPrevented).toBe(true)
  expect(screen.queryByText(/Changes not saved yet/)).toBeNull()

  publish(state.keeper === 'daemon' ? SYNCED : { keeper: 'browser', storage: 'ok' })
  expect(leaving().defaultPrevented).toBe(false)
})
