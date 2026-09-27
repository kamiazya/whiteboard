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
