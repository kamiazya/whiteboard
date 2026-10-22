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
  it('steps up to the 44px touch floor on a coarse pointer', () => {
    render(<ConnectionStatus state={null} />, { container: document.body })
    expect(screen.getByTestId('shell-mark-trigger').className).toContain('pointer-coarse:min-h-11')
    expect(screen.getByTestId('shell-mark-trigger').className).toContain('pointer-coarse:min-w-11')
  })

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
    expect(screen.queryByRole('button', { name: /disconnect/i })).toBeNull()
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
      <ConnectionStatus state={{ keeper: 'browser', storage: 'ok' }}>
        <button type="button">Use here</button>
      </ConnectionStatus>,
    )

    fireEvent.click(screen.getByRole('button', { name: /browser/i }))
    expect(await screen.findByText(/other browsers cannot see them/i)).toBeTruthy()
    // The slot for daemon-detection / capability content renders inside.
    expect(screen.getByRole('button', { name: 'Use here' })).toBeTruthy()
  })

  it('sync-off state says where edits go and offers the browser instead', async () => {
    const onWorkInBrowser = vi.fn()
    render(
      <ConnectionStatus
        state={{ keeper: 'daemon', session: 'sync-off' }}
        onWorkInBrowser={onWorkInBrowser}
      />,
    )

    const chip = screen.getByRole('button', { name: /sync off/i })
    fireEvent.click(chip)
    expect(await screen.findByText(/rejected this session/i)).toBeTruthy()
    // The dead-end fix: the popover states where edits are going...
    expect(screen.getByText(/edits stay in this browser/i)).toBeTruthy()
    // ...and a way forward. There is no pairing to redo (ADR-0050).
    expect(screen.queryByRole('button', { name: /re-pair/i })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /work in this browser instead/i }))
    expect(onWorkInBrowser).toHaveBeenCalledTimes(1)
  })

  // A daemon page that never opened a session is DRAWN as sync off — the same
  // word, the same panel and the same way out — but it holds nothing, so only
  // the session that ran may say edits are waiting in this browser.
  it.each([
    ['sync-off', true],
    ['not-opened', false],
  ] as const)('%s reads as sync off in the chip and the popover', async (session, holds) => {
    render(<ConnectionStatus state={{ keeper: 'daemon', session }} onWorkInBrowser={vi.fn()} />)

    const chip = screen.getByTestId('shell-mark-trigger')
    expect(chip.getAttribute('aria-label')).toMatch(/Sync off$/)
    fireEvent.click(chip)
    expect(await screen.findByText('Live sync is off')).toBeTruthy()
    expect(screen.getByRole('button', { name: /work in this browser instead/i })).toBeTruthy()
    const popover = screen.getByTestId('shell-mark-popover')
    expect(/edits stay in this browser/i.test(popover.textContent ?? '')).toBe(holds)
    if (!holds) expect(popover.textContent).toMatch(/nothing is held in this browser/i)
  })

  it('sync-off announces itself to assistive tech without a visual banner', () => {
    render(<ConnectionStatus state={{ keeper: 'daemon', session: 'sync-off' }} />)
    // A polite live region replaces the old role="alert" banner.
    expect(screen.getByRole('status', { name: /live sync off/i })).toBeTruthy()
  })

  it('names the offline copy, and says where a refused edit is held', async () => {
    render(<ConnectionStatus state={{ keeper: 'replica', storage: 'failed' }} />)
    expect(
      screen.getByRole('button', { name: 'Workspace — Offline copy — write failed' }),
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button'))
    expect(await screen.findByText(/in this tab only/i)).toBeTruthy()
  })

  it('says the offline copy is what keeps edits while the daemon is away', async () => {
    render(<ConnectionStatus state={{ keeper: 'replica', storage: 'ok' }} />)
    expect(screen.getByRole('button', { name: 'Workspace — Offline copy' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button'))
    expect(await screen.findByText(/ship to the daemon when it returns/i)).toBeTruthy()
  })

  it('headlines a refused offline-copy write as the failure, not the at-rest sentence', async () => {
    render(<ConnectionStatus state={{ keeper: 'replica', storage: 'failed' }} />)
    fireEvent.click(screen.getByRole('button'))
    expect(await screen.findByText('This browser could not be written to')).toBeTruthy()
    expect(screen.queryByText("Kept in this browser's copy for now")).toBeNull()
  })

  it.each([
    'ok',
    'stuck',
    'failed',
  ] as const)('never tells a browser-kept workspace a daemon keeps it (storage %s)', async (storage) => {
    render(<ConnectionStatus state={{ keeper: 'browser', storage }} />)
    fireEvent.click(screen.getByRole('button'))
    // Wait for the open popover and its browser panel, so the absences below
    // are read from a rendered panel rather than from a popover not yet open.
    const popover = await screen.findByTestId('shell-mark-popover')
    expect(popover.textContent).toMatch(/this browser/i)
    expect(popover.textContent).not.toMatch(/(ship to|reach) the daemon when it returns/i)
    expect(popover.textContent).not.toMatch(/Kept in this browser's copy for now/i)
  })

  it('says a write has not landed, in its own words, and explains it', async () => {
    render(<ConnectionStatus state={{ keeper: 'daemon', session: 'write-failed' }} />)
    expect(screen.getByRole('status', { name: /changes not saved yet/i })).toBeTruthy()
    fireEvent.click(screen.getByRole('button'))
    expect(await screen.findByText(/have not reached/i)).toBeTruthy()
  })
})
