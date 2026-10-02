import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetShellStatusForTests, setShellConnection } from '../lib/shell-status-store.js'
import { AppShell } from './AppShell.js'
// Real app styles so the mark is laid out the way it ships.
import '../index.css'

// The shell reads whatever the store holds. These tests publish the browser
// keeper's health straight into the store, with no page and no null in
// between, because that is the contract a publisher may rely on.
function renderShell() {
  render(
    <RouterProvider
      router={createMemoryRouter([{ path: '*', element: <AppShell daemon={false} /> }], {
        initialEntries: ['/w/default/d/c1'],
      })}
    />,
  )
}

const FAILED_COPY = /This browser could not be written to/i

describe('shell mark over the browser keeper storage health', () => {
  beforeEach(() => {
    resetShellStatusForTests()
  })

  afterEach(() => {
    cleanup()
    resetShellStatusForTests()
  })

  it('a write failure published after ok reaches the mark and popover, and recovery clears it', async () => {
    renderShell()
    act(() => {
      setShellConnection({
        state: { keeper: 'browser', storage: 'ok' },
        lastWrittenAt: '2026-01-01T00:00:00.000Z',
      })
    })
    expect(screen.getByTestId('shell-mark').getAttribute('data-storage')).toBe('ok')
    fireEvent.click(screen.getByTestId('shell-mark-trigger'))
    expect(await screen.findByText(/Kept in this browser/i)).toBeInTheDocument()
    expect(screen.queryByText(FAILED_COPY)).toBeNull()

    act(() => {
      setShellConnection({
        state: { keeper: 'browser', storage: 'failed' },
        lastWrittenAt: '2026-01-01T00:00:00.000Z',
      })
    })
    expect(await screen.findByText(FAILED_COPY)).toBeInTheDocument()
    expect(screen.getByTestId('shell-mark').getAttribute('data-storage')).toBe('failed')
    expect(screen.getByTestId('shell-mark-trigger').getAttribute('aria-label')).toMatch(
      /write failed/i,
    )
    expect(screen.getByRole('status').textContent).toBe('Writing to this browser failed')
    expect(screen.queryByText(/Kept in this browser/i)).toBeNull()

    act(() => {
      setShellConnection({
        state: { keeper: 'browser', storage: 'ok' },
        lastWrittenAt: '2026-01-01T00:00:09.000Z',
      })
    })
    expect(await screen.findByText(/Kept in this browser/i)).toBeInTheDocument()
    expect(screen.queryByText(FAILED_COPY)).toBeNull()
    expect(screen.getByTestId('shell-mark').getAttribute('data-storage')).toBe('ok')
  })
})
