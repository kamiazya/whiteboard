import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { celebrate } from '@/lib/celebrate'
import { initInstallPromptCapture, resetInstallPromptForTests } from '@/lib/install-prompt-store'
import { createUserSettingsStore, STORAGE_KEY } from '@/lib/user-settings-store'
import {
  bindApplyUpdate,
  bindCheckForUpdates,
  resetSwStatusForTests,
} from '../pwa/sw-status-store.js'
import { SettingsPage } from './SettingsPage.js'

vi.mock('@/lib/celebrate', () => ({ celebrate: vi.fn().mockResolvedValue(undefined) }))

beforeEach(() => {
  localStorage.clear()
  resetSwStatusForTests()
  resetInstallPromptForTests()
  vi.mocked(celebrate).mockClear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderAt(path: string, daemon?: { baseUrl: string; token: string | null }) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SettingsPage daemon={daemon} />
    </MemoryRouter>,
  )
}

describe('SettingsPage — routing layout', () => {
  it('/settings shows the mobile section list and the desktop General content', () => {
    renderAt('/settings')
    const mobile = screen.getByTestId('settings-mobile')
    const desktop = screen.getByTestId('settings-desktop')

    // Mobile: a list of section rows, no section content.
    expect(within(mobile).getByText('General')).toBeTruthy()
    expect(within(mobile).getByText('Data & app')).toBeTruthy()
    expect(within(mobile).getByText('Connections')).toBeTruthy()
    expect(within(mobile).queryByRole('radiogroup')).toBeNull()

    // Desktop: General content shown by default, single instance.
    expect(within(desktop).getByRole('radiogroup', { name: /theme/i })).toBeTruthy()
  })

  it('/settings/data shows the mobile detail view with a back-to-settings link', () => {
    renderAt('/settings/data')
    const mobile = screen.getByTestId('settings-mobile')
    expect(within(mobile).getByRole('link', { name: /settings/i })).toBeTruthy()
    expect(within(mobile).getByText('Protect your data')).toBeTruthy()
  })

  it('the back button falls back to the app root when settings was opened directly', () => {
    const router = createMemoryRouter([{ path: '*', element: <SettingsPage /> }], {
      initialEntries: ['/settings'],
    })
    render(<RouterProvider router={router} />)
    const desktop = screen.getByTestId('settings-desktop')
    fireEvent.click(within(desktop).getByRole('button', { name: /back/i }))
    expect(router.state.location.pathname).toBe('/')
  })

  it('the back button returns to the entry point even after wandering between sections', () => {
    // The gear passes the page it was clicked on as location.state.from.
    // Back must NOT be a history pop: list -> detail -> list wandering used
    // to make "Back" land on the previous settings section instead of
    // leaving settings.
    const router = createMemoryRouter([{ path: '*', element: <SettingsPage /> }], {
      initialEntries: [
        '/w/default/d/abc',
        { pathname: '/settings', state: { from: '/w/default/d/abc' } },
      ],
      initialIndex: 1,
    })
    render(<RouterProvider router={router} />)
    const desktop = screen.getByTestId('settings-desktop')
    // Wander: General -> Data & app -> Connections and back to General.
    fireEvent.click(within(desktop).getByRole('link', { name: /data & app/i }))
    fireEvent.click(within(desktop).getByRole('link', { name: /connections/i }))
    fireEvent.click(within(desktop).getByRole('link', { name: /general/i }))
    fireEvent.click(within(desktop).getByRole('button', { name: /back/i }))
    expect(router.state.location.pathname).toBe('/w/default/d/abc')
  })

  it('section links replace the history entry so the browser back button exits settings in one step', async () => {
    const router = createMemoryRouter([{ path: '*', element: <SettingsPage /> }], {
      initialEntries: [
        '/w/default/d/abc',
        { pathname: '/settings', state: { from: '/w/default/d/abc' } },
      ],
      initialIndex: 1,
    })
    render(<RouterProvider router={router} />)
    const desktop = screen.getByTestId('settings-desktop')
    fireEvent.click(within(desktop).getByRole('link', { name: /data & app/i }))
    fireEvent.click(within(desktop).getByRole('link', { name: /connections/i }))
    await act(async () => {
      await router.navigate(-1)
    })
    expect(router.state.location.pathname).toBe('/w/default/d/abc')
  })
})

describe('SettingsPage — General', () => {
  it('renders theme options and allows switching', () => {
    renderAt('/settings')
    const desktop = screen.getByTestId('settings-desktop')
    const lightBtn = within(desktop).getByRole('radio', { name: /light/i })
    const darkBtn = within(desktop).getByRole('radio', { name: /dark/i })
    const systemBtn = within(desktop).getByRole('radio', { name: /system/i })

    expect(systemBtn.getAttribute('aria-checked')).toBe('true')
    expect(lightBtn.getAttribute('aria-checked')).toBe('false')

    fireEvent.click(darkBtn)
    expect(darkBtn.getAttribute('aria-checked')).toBe('true')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('WebMCP toggle persists to user-settings', () => {
    renderAt('/settings')
    const desktop = screen.getByTestId('settings-desktop')
    const toggle = within(desktop).getByRole('switch')
    expect(toggle.getAttribute('aria-checked')).toBe('true')

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-checked')).toBe('false')

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!)
    expect(stored.capabilities.webMcpEnabled).toBe(false)
  })

  it('selecting a favicon style persists it to user-settings', () => {
    renderAt('/settings')
    const desktop = screen.getByTestId('settings-desktop')
    fireEvent.click(within(desktop).getByRole('radio', { name: /dot/i }))
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    expect(stored.appearance?.faviconStyle).toBe('dot')
  })

  it('reflects a persisted dot favicon preference on mount', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        storage: {},
        migration: {},
        capabilities: {},
        appearance: { faviconStyle: 'dot' },
      }),
    )
    renderAt('/settings')
    const desktop = screen.getByTestId('settings-desktop')
    expect(within(desktop).getByRole('radio', { name: /dot/i }).getAttribute('aria-checked')).toBe(
      'true',
    )
  })
})

describe('SettingsPage — Data & app setup journey', () => {
  afterEach(() => {
    Object.defineProperty(navigator, 'storage', { value: undefined, configurable: true })
  })

  function stubStorage(overrides: Partial<{ persisted: boolean; persistResult: boolean }>) {
    let persisted = overrides.persisted ?? false
    Object.defineProperty(navigator, 'storage', {
      value: {
        persisted: () => Promise.resolve(persisted),
        persist: () => {
          persisted = overrides.persistResult ?? true
          return Promise.resolve(persisted)
        },
      },
      configurable: true,
    })
  }

  it('shows the protect step granted when the browser persisted storage', async () => {
    stubStorage({ persisted: true })
    renderAt('/settings/data')
    const mobile = screen.getByTestId('settings-mobile')
    expect(await within(mobile).findByText('granted')).toBeTruthy()
  })

  it('says the browser manages persistence where the API is unavailable', async () => {
    renderAt('/settings/data')
    const mobile = screen.getByTestId('settings-mobile')
    expect(await within(mobile).findByText('managed by the browser')).toBeTruthy()
  })

  it('a browser that declines Protect says so, instead of leaving the row unchanged', async () => {
    // Chromium grants silently on engagement; a fresh profile is simply
    // refused. The refusal is the case that used to look like a dead button.
    stubStorage({ persisted: false, persistResult: false })
    renderAt('/settings/data')
    const mobile = screen.getByTestId('settings-mobile')
    fireEvent.click(await within(mobile).findByRole('button', { name: 'Protect' }))
    expect(
      await within(mobile).findByText(/browser turned this down|not granted it yet/i),
    ).toBeTruthy()
  })

  it('explains persistence without storage jargon', async () => {
    stubStorage({ persisted: false })
    renderAt('/settings/data')
    const mobile = screen.getByTestId('settings-mobile')
    await within(mobile).findByRole('button', { name: 'Protect' })
    expect(within(mobile).queryByText(/eviction/i)).toBeNull()
    expect(within(mobile).getByText(/delete.*(free up|space)|running low/i)).toBeTruthy()
  })

  it('describes the daemon step without developer vocabulary', async () => {
    stubStorage({ persisted: true })
    renderAt('/settings/data')
    const mobile = screen.getByTestId('settings-mobile')
    await within(mobile).findByText('granted')
    expect(within(mobile).queryByText(/daemon|AI agent/i)).toBeNull()
  })

  it('Protect asks for persistence and celebrates the live grant exactly once', async () => {
    stubStorage({ persisted: false, persistResult: true })
    renderAt('/settings/data')
    const mobile = screen.getByTestId('settings-mobile')
    fireEvent.click(await within(mobile).findByRole('button', { name: 'Protect' }))
    expect(await within(mobile).findByText('granted')).toBeTruthy()
    // celebrate fires from a passive effect on the same commit that renders
    // "granted", and the handler's promise chain runs outside act — so a
    // synchronous assertion here races the effect flush under load. Wait for
    // the call; the exactly-once claim is unchanged.
    await waitFor(() => expect(celebrate).toHaveBeenCalledTimes(1))
  })

  it('never celebrates a step that was already complete when the page opened', async () => {
    stubStorage({ persisted: true })
    renderAt('/settings/data')
    const mobile = screen.getByTestId('settings-mobile')
    await within(mobile).findByText('granted')
    expect(celebrate).not.toHaveBeenCalled()
  })

  it('shows the manual-install hint when no install prompt was captured', async () => {
    renderAt('/settings/data')
    const mobile = screen.getByTestId('settings-mobile')
    expect(
      await within(mobile).findByText(/menu may offer install or add to home screen/i),
    ).toBeTruthy()
  })

  it('offers Install when a beforeinstallprompt event was captured, and replays it', async () => {
    initInstallPromptCapture()
    const prompt = vi.fn().mockResolvedValue(undefined)
    const event = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
      prompt: () => Promise<void>
    }
    event.prompt = prompt
    window.dispatchEvent(event)

    renderAt('/settings/data')
    const mobile = screen.getByTestId('settings-mobile')
    fireEvent.click(await within(mobile).findByRole('button', { name: 'Install' }))
    expect(prompt).toHaveBeenCalledTimes(1)
  })

  it('celebrates when the app gets installed while the page is open', async () => {
    stubStorage({ persisted: true })
    initInstallPromptCapture()
    renderAt('/settings/data')
    const mobile = screen.getByTestId('settings-mobile')
    await within(mobile).findByText('granted')
    expect(celebrate).not.toHaveBeenCalled()

    await act(async () => {
      window.dispatchEvent(new Event('appinstalled'))
    })
    expect(await within(mobile).findByText('installed')).toBeTruthy()
    expect(celebrate).toHaveBeenCalledTimes(1)
  })

  it('links the daemon step to the Connections section when not connected', async () => {
    renderAt('/settings/data')
    const mobile = screen.getByTestId('settings-mobile')
    const link = await within(mobile).findByRole('link', { name: 'How to connect' })
    expect(link.getAttribute('href')).toBe('/settings/connections')
  })

  it('marks the daemon step connected when a daemon is provided', async () => {
    renderAt('/settings/data', { baseUrl: 'http://127.0.0.1:9999', token: 'tok' })
    const mobile = screen.getByTestId('settings-mobile')
    expect(await within(mobile).findByText('connected')).toBeTruthy()
  })
})

describe('SettingsPage — App version row', () => {
  it('degrades to managed-by-the-environment without a service worker registration', () => {
    renderAt('/settings/data')
    const mobile = screen.getByTestId('settings-mobile')
    expect(within(mobile).getByText('managed by the environment')).toBeTruthy()
    expect(within(mobile).queryByRole('button', { name: /check for updates/i })).toBeNull()
  })

  it('offers a manual check when a registration is bound', async () => {
    const check = vi.fn().mockResolvedValue(undefined)
    bindCheckForUpdates(check)
    renderAt('/settings/data')
    const mobile = screen.getByTestId('settings-mobile')
    expect(within(mobile).getByText('up to date')).toBeTruthy()
    await act(async () => {
      fireEvent.click(within(mobile).getByRole('button', { name: 'Check for updates' }))
    })
    expect(check).toHaveBeenCalledTimes(1)
  })

  it('offers Update now when an update is waiting', async () => {
    bindCheckForUpdates(vi.fn().mockResolvedValue(undefined))
    const apply = vi.fn().mockResolvedValue(undefined)
    bindApplyUpdate(apply)
    renderAt('/settings/data')
    const mobile = screen.getByTestId('settings-mobile')
    expect(within(mobile).getByText('update ready')).toBeTruthy()
    await act(async () => {
      fireEvent.click(within(mobile).getByRole('button', { name: 'Update now' }))
    })
    expect(apply).toHaveBeenCalledTimes(1)
  })
})

describe('SettingsPage — Connections', () => {
  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  it('shows a not-connected row when no daemon is provided', () => {
    renderAt('/settings/connections')
    const mobile = screen.getByTestId('settings-mobile')
    expect(within(mobile).getByText(/not connected/i)).toBeTruthy()
  })

  // Fonts are the daemon's, not this browser's: it is the daemon that
  // rasterises an export, so an empty list would be the wrong answer here.
  it('/settings/fonts says a daemon is needed before it offers any font', () => {
    renderAt('/settings/fonts')
    const mobile = screen.getByTestId('settings-mobile')
    expect(within(mobile).getByText(/not connected/i)).toBeTruthy()
    expect(within(mobile).queryByRole('button', { name: /^Install / })).toBeNull()
  })

  it('/settings/fonts lists the daemon catalogue when one is connected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.includes('/api/fonts')) {
          return jsonResponse({
            fonts: [
              {
                id: 'noto-sans-jp',
                family: 'Noto Sans JP',
                scripts: ['Japanese'],
                license: 'OFL-1.1',
                approxBytes: 9_589_900,
                installed: false,
              },
            ],
          })
        }
        return jsonResponse({}, 404)
      }),
    )
    renderAt('/settings/fonts', { baseUrl: 'http://127.0.0.1:9999', token: 'tok' })
    const mobile = screen.getByTestId('settings-mobile')
    expect(await within(mobile).findByRole('button', { name: 'Install Noto Sans JP' })).toBeTruthy()
  })

  // Discoverable before its precondition is met: the move to a daemon is
  // something the user should be able to find and read about while still
  // unpaired, not a control that materialises only once it is usable.
  it('offers the workspace move disabled until a daemon is connected', () => {
    renderAt('/settings/connections')
    const mobile = screen.getByTestId('settings-mobile')
    const button = within(mobile).getByTestId('promote-workspace-open')
    expect(button.hasAttribute('disabled')).toBe(true)
    expect(within(mobile).getByText(/connect a daemon to move/i)).toBeTruthy()
  })

  it('enables the workspace move when a daemon is connected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.includes('/api/pairing/grants')) return jsonResponse({ grants: [] })
        if (url.includes('/api/runtime/storage')) {
          return jsonResponse({ totalBytes: 0, fileCount: 0, byCategory: {} })
        }
        return jsonResponse({}, 404)
      }),
    )
    renderAt('/settings/connections', { baseUrl: 'http://127.0.0.1:9999', token: 'tok' })
    const mobile = screen.getByTestId('settings-mobile')
    const button = await within(mobile).findByTestId('promote-workspace-open')
    expect(button.hasAttribute('disabled')).toBe(false)
  })

  it('renders the paired-origins and storage cards when a daemon is provided', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.includes('/api/pairing/grants')) return jsonResponse({ grants: [] })
        if (url.includes('/api/runtime/storage')) {
          return jsonResponse({ totalBytes: 0, fileCount: 0, byCategory: {} })
        }
        return jsonResponse({}, 404)
      }),
    )
    renderAt('/settings/connections', { baseUrl: 'http://127.0.0.1:9999', token: 'tok' })
    const mobile = screen.getByTestId('settings-mobile')
    expect(await within(mobile).findByText('Paired web apps')).toBeTruthy()
    expect(
      await within(mobile).findByRole('button', { name: /refresh storage usage/i }),
    ).toBeTruthy()
  })
})

// Disconnecting is a management action: it has an intent behind it, so the
// user can go looking for it. That is what makes Settings the right home —
// unlike a dropped sync, which nobody goes looking for and which therefore
// has to stay on the chip that reports it.
describe('SettingsPage — disconnecting from a daemon', () => {
  const DAEMON = 'http://127.0.0.1:3099'

  function renderConnections(onDisconnected = vi.fn()) {
    render(
      <MemoryRouter initialEntries={['/settings/connections']}>
        <SettingsPage daemon={{ baseUrl: DAEMON, token: null }} onDisconnected={onDisconnected} />
      </MemoryRouter>,
    )
    return onDisconnected
  }

  it('offers the action, and says what it does NOT do', async () => {
    renderConnections()
    const desktop = screen.getByTestId('settings-desktop')
    const button = await within(desktop).findByTestId('settings-disconnect')
    expect(button).toBeTruthy()
    // "Disconnect" reads like a destructive word, so the copy has to deny the
    // destruction it implies.
    const section = button.closest('section')
    expect(section?.textContent).toMatch(/stays on the daemon|not deleted/i)
    expect(section?.textContent).toMatch(/not.*(unpair|revoke)|pairing is not revoked/i)
  })

  it('records the dismissal so discovery does not bring it straight back', async () => {
    // The default port range is rescanned on every visit, so forgetting alone
    // would return this daemon and make the action read as a no-op.
    createUserSettingsStore().update((current) => ({
      ...current,
      storage: { ...current.storage, daemonBaseUrl: DAEMON, knownDaemonBaseUrls: [DAEMON] },
    }))
    // Asserted rather than assumed: a seed that failed the store's own
    // validation would make every assertion below pass vacuously.
    expect(createUserSettingsStore().load().storage.daemonBaseUrl).toBe(DAEMON)

    const onDisconnected = renderConnections()
    const desktop = screen.getByTestId('settings-desktop')
    fireEvent.click(await within(desktop).findByTestId('settings-disconnect'))

    const storage = createUserSettingsStore().load().storage
    expect(storage.dismissedDaemonBaseUrls).toContain(DAEMON)
    expect(storage.knownDaemonBaseUrls ?? []).not.toContain(DAEMON)
    // App.tsx reads daemonBaseUrl to decide a load is daemon-backed, so
    // leaving it set reconnects on the next visit and "this browser stops
    // using it" becomes false the moment the user reloads.
    expect(storage.daemonBaseUrl).toBeUndefined()
    expect(onDisconnected).toHaveBeenCalledTimes(1)
  })

  it('shows nothing to disconnect from when no daemon is connected', () => {
    render(
      <MemoryRouter initialEntries={['/settings/connections']}>
        <SettingsPage />
      </MemoryRouter>,
    )
    expect(screen.queryByTestId('settings-disconnect')).toBeNull()
  })
})
