import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetInstallPromptForTests } from '@/lib/install-prompt-store'
import { resetShellStatusForTests, setShellConnection } from '@/lib/shell-status-store'
import { createUserSettingsStore } from '@/lib/user-settings-store'
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

function renderShell(
  daemonConnected: boolean,
  at = '/local/c1',
  onContinueBrowserLocal?: () => void,
) {
  const router = createMemoryRouter(
    [
      {
        path: '*',
        element: (
          <AppShell daemon={daemonConnected} onContinueBrowserLocal={onContinueBrowserLocal} />
        ),
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
  const CTA_TEXT =
    'Connect a local daemon (MCP) to unlock version history, workspaces, variations, and combining changes'

  it('shows no chip until a page publishes a live session', () => {
    renderShell(true)
    expect(screen.queryByTestId('connection-chip')).toBeNull()
  })

  it.each([
    ['local', /local/i],
    ['synced', /synced/i],
    ['reconnecting', /reconnecting/i],
    ['sync-off', /sync off/i],
  ] as const)('renders the %s state the page published', async (state, label) => {
    setShellConnection({ state, daemonBaseUrl: 'http://127.0.0.1:3099' })
    renderShell(state !== 'local')
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
    setShellConnection({ state: 'local' })
    renderShell(false)
    expect(screen.queryByText(CTA_TEXT)).toBeNull()

    fireEvent.click(await screen.findByTestId('connection-chip'))
    expect(await screen.findByText(CTA_TEXT)).toBeTruthy()
  })

  it('offers the browser-local escape from the sync-off popover', async () => {
    const onContinueBrowserLocal = vi.fn()
    setShellConnection({ state: 'sync-off', daemonBaseUrl: 'http://127.0.0.1:3099' })
    renderShell(true, '/w/ws/document/a.canvas', onContinueBrowserLocal)

    fireEvent.click(await screen.findByTestId('connection-chip'))
    fireEvent.click(await screen.findByRole('button', { name: /continue in browser-local/i }))
    expect(onContinueBrowserLocal).toHaveBeenCalledTimes(1)
  })

  it('disconnecting records the dismissal so discovery does not bring it straight back', async () => {
    const daemonBaseUrl = 'http://127.0.0.1:3099'
    const onContinueBrowserLocal = vi.fn()
    // Seeded through the store, not by writing JSON: a hand-built payload that
    // fails the store's own validation is silently replaced by defaults, and
    // every assertion below would then pass without touching the real state.
    createUserSettingsStore().update((current) => ({
      ...current,
      storage: {
        ...current.storage,
        localDaemonBaseUrl: daemonBaseUrl,
        knownDaemonBaseUrls: [daemonBaseUrl],
      },
    }))
    expect(createUserSettingsStore().load().storage.localDaemonBaseUrl).toBe(daemonBaseUrl)

    setShellConnection({ state: 'synced', daemonBaseUrl })
    renderShell(true, '/w/ws/document/a.canvas', onContinueBrowserLocal)

    fireEvent.click(await screen.findByTestId('connection-chip'))
    fireEvent.click(await screen.findByTestId('connection-disconnect'))

    expect(onContinueBrowserLocal).toHaveBeenCalledTimes(1)
    const storage = createUserSettingsStore().load().storage
    expect(storage.dismissedDaemonBaseUrls).toContain(daemonBaseUrl)
    expect(storage.knownDaemonBaseUrls ?? []).not.toContain(daemonBaseUrl)
    // App.tsx reads localDaemonBaseUrl to decide a page is daemon-backed, so
    // leaving it set reconnects on the next load — which makes the popover's
    // "this browser stops using it" false the moment the user reloads.
    expect(storage.localDaemonBaseUrl).toBeUndefined()
  })

  it('withholds the disconnect action where the app has no browser-local escape', async () => {
    setShellConnection({ state: 'synced', daemonBaseUrl: 'http://127.0.0.1:3099' })
    renderShell(true)
    fireEvent.click(await screen.findByTestId('connection-chip'))
    await waitFor(() => expect(screen.getByTestId('connection-popover')).toBeTruthy())
    expect(screen.queryByTestId('connection-disconnect')).toBeNull()
  })
})
