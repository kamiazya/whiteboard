import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetInstallPromptForTests } from '@/lib/install-prompt-store'
import { resetShellStatusForTests, setShellConnection } from '@/lib/shell-status-store'
import { resetSwStatusForTests } from '../pwa/sw-status-store.js'
import { AppShell } from './AppShell.js'

beforeEach(() => {
  localStorage.clear()
  resetSwStatusForTests()
  resetInstallPromptForTests()
  resetShellStatusForTests()
})

afterEach(() => {
  cleanup()
  Object.defineProperty(navigator, 'storage', { value: undefined, configurable: true })
})

function renderShell(daemonConnected: boolean, at = '/local/c1', onWorkInBrowser?: () => void) {
  const router = createMemoryRouter(
    [
      {
        path: '*',
        element: <AppShell daemon={daemonConnected} onWorkInBrowser={onWorkInBrowser} />,
      },
    ],
    {
      initialEntries: [at],
    },
  )
  render(<RouterProvider router={router} />, { container: document.body })
  return router
}

describe('AppShell', () => {
  it('brand mark links home', () => {
    renderShell(true)
    const home = screen.getByRole('link', { name: 'Home' })
    expect(home.getAttribute('href')).toBe('/')
  })

  it('alpha chip opens the honesty popover with a protect link', async () => {
    renderShell(true)
    fireEvent.click(screen.getByRole('button', { name: /alpha/i }))
    expect(await screen.findByText(/durability is not guaranteed/i)).toBeTruthy()
    const protect = screen.getByRole('link', { name: /protect your data/i })
    expect(protect.getAttribute('href')).toBe('/settings/data')
  })

  it('settings gear navigates to /settings carrying the entry point', () => {
    const router = renderShell(true, '/local/c1')
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(router.state.location.pathname).toBe('/settings')
    expect((router.state.location.state as { from?: string }).from).toBe('/local/c1')
  })

  it('names what the dot is about, so it reads as a task and not a warning', () => {
    renderShell(false)
    expect(screen.getByTestId('settings-nudge')).toBeTruthy()
    expect(screen.getByRole('button', { name: /settings.*(step|setup)/i })).toBeTruthy()
  })

  it('carries the nudge dot while a setup todo remains (no daemon)', () => {
    renderShell(false)
    expect(screen.getByTestId('settings-nudge')).toBeTruthy()
  })

  it('lights the nudge when the daemon page reports a live auth error', async () => {
    Object.defineProperty(navigator, 'storage', {
      value: { persisted: () => Promise.resolve(true) },
      configurable: true,
    })
    // Sync off IS the auth error: re-pairing is the only way out of it, so it
    // counts as disconnected for the attention dot. Transient reconnects do not.
    setShellConnection({ state: 'sync-off', daemonBaseUrl: 'http://127.0.0.1:3099' })
    renderShell(true)
    expect(await screen.findByTestId('settings-nudge')).toBeTruthy()
  })

  it('shows no nudge when everything reachable is complete', async () => {
    Object.defineProperty(navigator, 'storage', {
      value: { persisted: () => Promise.resolve(true) },
      configurable: true,
    })
    renderShell(true)
    // allow the persistence query to settle
    await screen.findByRole('button', { name: 'Settings' })
    expect(screen.queryByTestId('settings-nudge')).toBeNull()
  })
})

// The connection is an APP-level fact, not a document-level one: which daemon
// this browser talks to does not change when you open a different document.
// It lives beside the settings gear for the same reason the gear does — the
// document's own surface is for the document.
describe('AppShell — the connection chip', () => {
  // Matched loosely: the CTA is two sentences across JSX lines, so an exact
  // string match would be asserting the source's line breaks, not the copy.
  const CTA = /Connect a daemon \(MCP\) for version history/i
  const CTA_LIMIT = /Documents already in this browser stay here/i

  it('shows no chip until a page publishes a live session', () => {
    renderShell(true)
    expect(screen.queryByTestId('connection-chip')).toBeNull()
  })

  it.each([
    ['browser', /browser/i],
    ['synced', /synced/i],
    ['reconnecting', /reconnecting/i],
    ['sync-off', /sync off/i],
  ] as const)('renders the %s state the page published', async (state, label) => {
    setShellConnection({ state, daemonBaseUrl: 'http://127.0.0.1:3099' })
    renderShell(state !== 'browser')
    expect((await screen.findByTestId('connection-chip')).textContent).toMatch(label)
  })

  it('follows the page as its session changes, without a remount', async () => {
    setShellConnection({ state: 'synced', daemonBaseUrl: 'http://127.0.0.1:3099' })
    renderShell(true)
    expect((await screen.findByTestId('connection-chip')).textContent).toMatch(/synced/i)

    act(() => setShellConnection({ state: 'reconnecting', daemonBaseUrl: 'http://127.0.0.1:3099' }))
    expect(screen.getByTestId('connection-chip').textContent).toMatch(/reconnecting/i)

    // Leaving the document takes the claim with it: nothing on an index page
    // is synced, and a latched chip would say otherwise.
    act(() => setShellConnection(null))
    expect(screen.queryByTestId('connection-chip')).toBeNull()
  })

  it('carries the capability CTA inside the Local popover, not in page chrome', async () => {
    setShellConnection({ state: 'browser' })
    renderShell(false)
    expect(screen.queryByText(CTA)).toBeNull()

    fireEvent.click(await screen.findByTestId('connection-chip'))
    expect(await screen.findByText(CTA)).toBeTruthy()
    // The CTA names what connecting does NOT do today: documents already in
    // this browser are not carried over, they are imported one at a time.
    expect(screen.getByText(CTA_LIMIT)).toBeTruthy()
  })

  it('offers the browser-local escape from the sync-off popover', async () => {
    const onWorkInBrowser = vi.fn()
    setShellConnection({ state: 'sync-off', daemonBaseUrl: 'http://127.0.0.1:3099' })
    renderShell(true, '/w/ws/document/a.canvas', onWorkInBrowser)

    fireEvent.click(await screen.findByTestId('connection-chip'))
    fireEvent.click(await screen.findByRole('button', { name: /work in this browser instead/i }))
    expect(onWorkInBrowser).toHaveBeenCalledTimes(1)
  })

  // The management action moved to Settings (see SettingsPage.test.tsx). What
  // the shell keeps is the report and the pointer to where the action lives.
  it('points at Settings rather than carrying the management action itself', async () => {
    setShellConnection({ state: 'synced', daemonBaseUrl: 'http://127.0.0.1:3099' })
    renderShell(true)
    fireEvent.click(await screen.findByTestId('connection-chip'))
    await waitFor(() => expect(screen.getByTestId('connection-popover')).toBeTruthy())

    expect(screen.queryByTestId('connection-disconnect')).toBeNull()
    expect(screen.getByRole('link', { name: /manage in settings/i }).getAttribute('href')).toBe(
      '/settings/connections',
    )
  })
})
