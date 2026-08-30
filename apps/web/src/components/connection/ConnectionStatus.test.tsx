// D1 of the design refactor (brief: design-refactor-brief-2026-08-08): the
// connection story collapses from standing banners into ONE header chip.
// The chip is the always-visible state signal; everything sentence-shaped
// (explanation, data location, recovery actions) lives in its popover.
import { cleanup, fireEvent, render as rtlRender, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConnectionStatus } from './ConnectionStatus.js'

// The synced popover links into Settings, so the chip needs the router it
// has in production.
function render(ui: ReactElement, options?: Parameters<typeof rtlRender>[1]) {
  return rtlRender(<MemoryRouter>{ui}</MemoryRouter>, options)
}

afterEach(cleanup)

describe('ConnectionStatus chip', () => {
  // Management belongs in Settings, recovery belongs here. Disconnecting is
  // something you go looking for with an intent; sync dropping is not, and
  // sending someone to Settings mid-failure adds a step at the worst moment.
  it('carries no management action while sync is on — that lives in Settings', () => {
    render(
      <ConnectionStatus
        state={{ keeper: 'daemon', session: 'synced' }}
        daemonBaseUrl="http://127.0.0.1:3099"
      />,
      {
        container: document.body,
      },
    )
    fireEvent.click(screen.getByTestId('shell-mark-trigger'))

    const popover = screen.getByTestId('shell-mark-popover')
    expect(screen.queryByTestId('connection-disconnect')).toBeNull()
    // It still says where the data is, and points at where the action lives.
    expect(popover.textContent).toMatch(/127\.0\.0\.1:3099/)
    expect(screen.getByRole('link', { name: /settings/i }).getAttribute('href')).toBe(
      '/settings/connections',
    )
  })

  it('explains the reconnecting state instead of opening an empty popover', () => {
    // The chip can reach this state, so the popover must have something to
    // say; a state with no branch renders an empty box on click. Reconnecting
    // is SESSION health on a daemon-kept document — the keeper axis cannot
    // say it, which is the point of the two-axis state.
    render(<ConnectionStatus state={{ keeper: 'daemon', session: 'reconnecting' }} />, {
      container: document.body,
    })
    fireEvent.click(screen.getByTestId('shell-mark-trigger'))

    const popover = screen.getByTestId('shell-mark-popover')
    expect(popover.textContent).toMatch(/not running/i)
    // The recovery promise is only sound because the session re-sends the whole
    // document on reconnect; a backend hands a closed socket one delta and it
    // is gone. If that resend is ever removed, this sentence becomes a lie.
    expect(popover.textContent).toMatch(/sent when the connection returns/i)
  })

  it('synced state shows a quiet chip and explains where data lives in the popover', async () => {
    render(
      <ConnectionStatus
        state={{ keeper: 'daemon', session: 'synced' }}
        daemonBaseUrl="http://127.0.0.1:3099"
      />,
    )

    const chip = screen.getByRole('button', { name: /synced/i })
    expect(chip).toBeTruthy()
    // No standing sentence copy outside the popover: the actual popover
    // explanation must not be rendered until the chip is opened.
    expect(screen.queryByText(/changes are saved to the daemon on this machine/i)).toBeNull()
    expect(screen.queryByText(/live sync is on/i)).toBeNull()

    fireEvent.click(chip)
    expect(await screen.findByText(/live sync is on/i)).toBeTruthy()
    expect(screen.getByText(/127\.0\.0\.1:3099/)).toBeTruthy()
  })

  it('browser state explains browser-only storage and hosts extra content (daemon detection)', async () => {
    render(
      <ConnectionStatus state={{ keeper: 'browser' }}>
        <button type="button">Use here</button>
      </ConnectionStatus>,
    )

    fireEvent.click(screen.getByRole('button', { name: /browser/i }))
    expect(await screen.findByText(/other browsers cannot see them/i)).toBeTruthy()
    // The slot for daemon-detection / capability content renders inside.
    expect(screen.getByRole('button', { name: 'Use here' })).toBeTruthy()
  })

  it('sync-off state carries attention styling and BOTH recovery actions', async () => {
    const onRepair = vi.fn()
    const onWorkInBrowser = vi.fn()
    render(
      <ConnectionStatus
        state={{ keeper: 'daemon', session: 'sync-off' }}
        onRepair={onRepair}
        onWorkInBrowser={onWorkInBrowser}
      />,
    )

    const chip = screen.getByRole('button', { name: /sync off/i })
    fireEvent.click(chip)
    expect(await screen.findByText(/rejected this session/i)).toBeTruthy()
    // The dead-end fix: the popover states where edits are going...
    expect(screen.getByText(/edits stay in this browser/i)).toBeTruthy()
    // ...and offers both ways forward.
    fireEvent.click(screen.getByRole('button', { name: /re-pair/i }))
    expect(onRepair).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: /work in this browser instead/i }))
    expect(onWorkInBrowser).toHaveBeenCalledTimes(1)
  })

  it('sync-off announces itself to assistive tech without a visual banner', () => {
    render(
      <ConnectionStatus state={{ keeper: 'daemon', session: 'sync-off' }} onRepair={vi.fn()} />,
    )
    // A polite live region replaces the old role="alert" banner.
    expect(screen.getByRole('status', { name: /live sync off/i })).toBeTruthy()
  })
})
