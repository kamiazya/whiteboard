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
  it('brand mark links home while no page holds a session', () => {
    // With nothing to report the mark is not a menu: it is the way home,
    // exactly as before. The popover appears only once there is a state for
    // it to explain.
    renderShell(true)
    const home = screen.getByRole('link', { name: 'Home' })
    expect(home.getAttribute('href')).toBe('/')
    expect(screen.getByTestId('shell-mark').getAttribute('data-keeper')).toBeNull()
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
    setShellConnection({
      state: { keeper: 'daemon', session: 'sync-off' },
      daemonBaseUrl: 'http://127.0.0.1:3099',
    })
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
describe('AppShell — the mark as the connection carrier', () => {
  // Matched loosely: the CTA is two sentences across JSX lines, so an exact
  // string match would be asserting the source's line breaks, not the copy.
  const CTA = /Connect a daemon \(MCP\) for version history/i
  const CTA_LIMIT = /move this workspace to it from Settings/i

  it('carries no state until a page publishes a live session', () => {
    renderShell(true)
    expect(screen.queryByTestId('shell-mark-trigger')).toBeNull()
    expect(screen.getByTestId('shell-mark').getAttribute('data-keeper')).toBeNull()
  })

  it('leaves exactly one state carrier in the row, not two', async () => {
    // The row had two carriers and no subject. One carrier now answers both
    // "which workspace" and "is my work safe"; a chip left beside it would be
    // the same fact twice, which DESIGN.md's closed-set rule exists to stop.
    //
    // Counted rather than named: asserting the OLD test id is absent would
    // pass just as well if a replacement chip were added under a new one, and
    // a guard that cannot see its subject is no guard.
    setShellConnection({
      state: { keeper: 'daemon', session: 'synced' },
      daemonBaseUrl: 'http://127.0.0.1:3099',
    })
    renderShell(true)
    const header = (await screen.findByTestId('shell-mark-trigger')).closest('header')
    expect(header).not.toBeNull()
    const carriers = header?.querySelectorAll(
      '[data-testid="shell-mark-cap"], [data-testid="state-dot"]',
    )
    expect(carriers?.length).toBe(1)
  })

  it.each([
    ['browser-kept', { keeper: 'browser' }, /browser/i],
    ['synced', { keeper: 'daemon', session: 'synced' }, /synced/i],
    ['reconnecting', { keeper: 'daemon', session: 'reconnecting' }, /reconnecting/i],
    ['sync-off', { keeper: 'daemon', session: 'sync-off' }, /sync off/i],
  ] as const)('renders the %s state the page published', async (_name, state, label) => {
    setShellConnection({ state, daemonBaseUrl: 'http://127.0.0.1:3099' })
    renderShell(state.keeper === 'daemon')
    // The mark has no room for the word, so the accessible name carries it —
    // and it must, because two of these four states share a tone.
    expect((await screen.findByTestId('shell-mark-trigger')).getAttribute('aria-label')).toMatch(
      label,
    )
  })

  it('follows the page as its session changes, without a remount', async () => {
    setShellConnection({
      state: { keeper: 'daemon', session: 'synced' },
      daemonBaseUrl: 'http://127.0.0.1:3099',
    })
    renderShell(true)
    expect((await screen.findByTestId('shell-mark-trigger')).getAttribute('aria-label')).toMatch(
      /synced/i,
    )

    act(() =>
      setShellConnection({
        state: { keeper: 'daemon', session: 'reconnecting' },
        daemonBaseUrl: 'http://127.0.0.1:3099',
      }),
    )
    expect(screen.getByTestId('shell-mark-trigger').getAttribute('aria-label')).toMatch(
      /reconnecting/i,
    )
    expect(screen.getByTestId('shell-mark').getAttribute('data-session')).toBe('reconnecting')

    // Leaving the document takes the claim with it: nothing on an index page
    // is synced, and a latched mark would say otherwise.
    act(() => setShellConnection(null))
    expect(screen.queryByTestId('shell-mark-trigger')).toBeNull()
    expect(screen.getByTestId('shell-mark').getAttribute('data-session')).toBeNull()
  })

  it('carries the capability CTA inside the Local popover, not in page chrome', async () => {
    setShellConnection({ state: { keeper: 'browser' } })
    renderShell(false)
    expect(screen.queryByText(CTA)).toBeNull()

    fireEvent.click(await screen.findByTestId('shell-mark-trigger'))
    expect(await screen.findByText(CTA)).toBeTruthy()
    // The CTA points at where the move lives (Settings manages; the chip
    // only reports and nudges) — whole-workspace promotion is implemented,
    // so the old "import them one at a time" disclaimer would now be false.
    expect(screen.getByText(CTA_LIMIT)).toBeTruthy()
  })

  // Slice 8's honest-detach floor: a cold load whose silent renewal fails
  // falls back to the browser flow with the stored daemon still configured.
  // For a workspace that was MOVED to that daemon, resuming keeper duties
  // silently would hide that edits made here diverge from the daemon copy —
  // so the browser popover discloses the move instead of claiming nothing.
  it('the browser popover discloses a recorded move to the still-configured daemon', async () => {
    createUserSettingsStore().update((current) => ({
      ...current,
      storage: { ...current.storage, daemonBaseUrl: 'http://127.0.0.1:3099' },
      migration: {
        ...current.migration,
        promotion: {
          at: '2026-08-28T12:00:00.000Z',
          daemonBaseUrl: 'http://127.0.0.1:3099',
          workspaceId: 'ws-a',
          ok: true,
          promotedCount: 2,
        },
      },
    }))
    setShellConnection({ state: { keeper: 'browser' } })
    renderShell(false)
    fireEvent.click(await screen.findByTestId('shell-mark-trigger'))
    const notice = await screen.findByTestId('promoted-elsewhere-notice')
    expect(notice.textContent).toMatch(/moved to the daemon/i)
    expect(notice.textContent).toMatch(/stay in this browser/i)
    // Reachability is unknown from here, so the copy must not claim it.
    expect(notice.textContent).not.toMatch(/unreachable|offline|cannot be reached/i)
  })

  it('no move disclosure without a matching promotion record', async () => {
    // A promotion recorded against a daemon the browser no longer uses (or
    // none at all) is not this connection's story to tell.
    createUserSettingsStore().update((current) => ({
      ...current,
      storage: { ...current.storage, daemonBaseUrl: 'http://127.0.0.1:3099' },
      migration: {
        ...current.migration,
        promotion: {
          at: '2026-08-28T12:00:00.000Z',
          daemonBaseUrl: 'http://127.0.0.1:4200',
          workspaceId: 'ws-a',
          ok: true,
        },
      },
    }))
    setShellConnection({ state: { keeper: 'browser' } })
    renderShell(false)
    fireEvent.click(await screen.findByTestId('shell-mark-trigger'))
    await screen.findByText(CTA)
    expect(screen.queryByTestId('promoted-elsewhere-notice')).toBeNull()
  })

  it('offers the escape to the browser from the sync-off popover', async () => {
    const onWorkInBrowser = vi.fn()
    setShellConnection({
      state: { keeper: 'daemon', session: 'sync-off' },
      daemonBaseUrl: 'http://127.0.0.1:3099',
    })
    renderShell(true, '/w/ws/document/a.canvas', onWorkInBrowser)

    fireEvent.click(await screen.findByTestId('shell-mark-trigger'))
    fireEvent.click(await screen.findByRole('button', { name: /work in this browser instead/i }))
    expect(onWorkInBrowser).toHaveBeenCalledTimes(1)
  })

  // The management action moved to Settings (see SettingsPage.test.tsx). What
  // the shell keeps is the report and the pointer to where the action lives.
  it('points at Settings rather than carrying the management action itself', async () => {
    setShellConnection({
      state: { keeper: 'daemon', session: 'synced' },
      daemonBaseUrl: 'http://127.0.0.1:3099',
    })
    renderShell(true)
    fireEvent.click(await screen.findByTestId('shell-mark-trigger'))
    await waitFor(() => expect(screen.getByTestId('connection-popover')).toBeTruthy())

    expect(screen.queryByTestId('connection-disconnect')).toBeNull()
    expect(screen.getByRole('link', { name: /manage in settings/i }).getAttribute('href')).toBe(
      '/settings/connections',
    )
  })
})
