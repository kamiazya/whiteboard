// D1 of the design refactor (brief: design-refactor-brief-2026-08-08): the
// connection story collapses from standing banners into ONE header chip.
// The chip is the always-visible state signal; everything sentence-shaped
// (explanation, data location, recovery actions) lives in its popover.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConnectionStatus } from './ConnectionStatus.js'

afterEach(cleanup)

describe('ConnectionStatus chip', () => {
  it('offers a way out while sync is on, and says what it does not do', () => {
    // Connected was the one state with no exit: every other state offers a
    // next step, so a user who picked the wrong daemon had to clear storage.
    const onDisconnect = vi.fn()
    render(
      <ConnectionStatus
        state="synced"
        daemonBaseUrl="http://127.0.0.1:3099"
        onDisconnect={onDisconnect}
      />,
      { container: document.body },
    )
    fireEvent.click(screen.getByTestId('connection-chip'))

    const popover = screen.getByTestId('connection-popover')
    // Disconnecting stops using this daemon here; it neither unpairs nor
    // deletes anything on the daemon, and the copy has to say so.
    expect(popover.textContent).toMatch(/stays on the daemon|not deleted/i)
    fireEvent.click(screen.getByTestId('connection-disconnect'))
    expect(onDisconnect).toHaveBeenCalledTimes(1)
  })

  it('explains the reconnecting state instead of opening an empty popover', () => {
    // The chip can reach this state, so the popover must have something to
    // say; a state with no branch renders an empty box on click.
    render(<ConnectionStatus state="reconnecting" />, { container: document.body })
    fireEvent.click(screen.getByTestId('connection-chip'))

    const popover = screen.getByTestId('connection-popover')
    expect(popover.textContent).toMatch(/not running/i)
    // The recovery promise is only sound because the session re-sends the whole
    // document on reconnect; a backend hands a closed socket one delta and it
    // is gone. If that resend is ever removed, this sentence becomes a lie.
    expect(popover.textContent).toMatch(/sent when the connection returns/i)
  })

  it('synced state shows a quiet chip and explains where data lives in the popover', async () => {
    render(<ConnectionStatus state="synced" daemonBaseUrl="http://127.0.0.1:3099" />)

    const chip = screen.getByRole('button', { name: /synced/i })
    expect(chip).toBeTruthy()
    // No standing sentence copy outside the popover: the actual popover
    // explanation must not be rendered until the chip is opened.
    expect(screen.queryByText(/changes are saved to your local daemon/i)).toBeNull()
    expect(screen.queryByText(/live sync is on/i)).toBeNull()

    fireEvent.click(chip)
    expect(await screen.findByText(/live sync is on/i)).toBeTruthy()
    expect(screen.getByText(/127\.0\.0\.1:3099/)).toBeTruthy()
  })

  it('local state explains browser-only storage and hosts extra content (daemon detection)', async () => {
    render(
      <ConnectionStatus state="local">
        <button type="button">Use here</button>
      </ConnectionStatus>,
    )

    fireEvent.click(screen.getByRole('button', { name: /local/i }))
    expect(await screen.findByText(/only in this browser/i)).toBeTruthy()
    // The slot for daemon-detection / capability content renders inside.
    expect(screen.getByRole('button', { name: 'Use here' })).toBeTruthy()
  })

  it('sync-off state carries attention styling and BOTH recovery actions', async () => {
    const onRepair = vi.fn()
    const onContinueBrowserLocal = vi.fn()
    render(
      <ConnectionStatus
        state="sync-off"
        onRepair={onRepair}
        onContinueBrowserLocal={onContinueBrowserLocal}
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
    fireEvent.click(screen.getByRole('button', { name: /continue in browser-local/i }))
    expect(onContinueBrowserLocal).toHaveBeenCalledTimes(1)
  })

  it('sync-off announces itself to assistive tech without a visual banner', () => {
    render(<ConnectionStatus state="sync-off" onRepair={vi.fn()} />)
    // A polite live region replaces the old role="alert" banner.
    expect(screen.getByRole('status', { name: /live sync off/i })).toBeTruthy()
  })
})
