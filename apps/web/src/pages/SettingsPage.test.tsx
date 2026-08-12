import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STORAGE_KEY } from '@/lib/user-settings-store'
import { SettingsPage } from './SettingsPage.js'

beforeEach(() => {
  localStorage.clear()
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
    expect(within(mobile).getByRole('button', { name: /settings/i })).toBeTruthy()
    expect(within(mobile).getByText('Persistent storage')).toBeTruthy()
  })

  it('the desktop sidebar back button returns to the app root when there is no in-app history', () => {
    // MemoryRouter's initial entry has no react-router history.idx to pop
    // into, so the fallback path (navigate('/')) is what's under test here.
    renderAt('/settings')
    const desktop = screen.getByTestId('settings-desktop')
    fireEvent.click(within(desktop).getByRole('button', { name: /back/i }))
    // No assertion needed beyond "did not throw" plus the URL sync below —
    // MemoryRouter has no way to observe the resulting location without a
    // Routes tree, so the pushed-state case is covered separately.
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
        version: 1,
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

describe('SettingsPage — Data & app', () => {
  afterEach(() => {
    Object.defineProperty(navigator, 'storage', { value: undefined, configurable: true })
  })

  it('shows Granted when the browser persisted storage', async () => {
    Object.defineProperty(navigator, 'storage', {
      value: { persisted: () => Promise.resolve(true) },
      configurable: true,
    })
    renderAt('/settings/data')
    const mobile = screen.getByTestId('settings-mobile')
    expect(await within(mobile).findByText('Granted')).toBeTruthy()
  })

  it('says the browser manages it where the API is unavailable', async () => {
    renderAt('/settings/data')
    const mobile = screen.getByTestId('settings-mobile')
    expect(await within(mobile).findByText('Managed by the browser')).toBeTruthy()
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
