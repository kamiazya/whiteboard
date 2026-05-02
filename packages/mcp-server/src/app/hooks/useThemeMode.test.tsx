import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import {
  THEME_STORAGE_KEY,
  applyThemeClass,
  readPersistedTheme,
  resolveTheme,
  useThemeMode,
} from './useThemeMode.js'

// Minimal matchMedia stub: tracks listeners so tests can simulate the OS
// flipping prefers-color-scheme without a real browser.
function installMatchMediaMock(initial: 'light' | 'dark') {
  let prefersDark = initial === 'dark'
  const listeners = new Set<(e: { matches: boolean }) => void>()
  const mql = {
    get matches() {
      return prefersDark
    },
    addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => {
      listeners.add(fn)
    },
    removeEventListener: (_: string, fn: (e: { matches: boolean }) => void) => {
      listeners.delete(fn)
    },
  }
  vi.stubGlobal(
    'matchMedia',
    vi.fn((_query: string) => mql),
  )
  ;(window as unknown as { matchMedia: typeof window.matchMedia }).matchMedia =
    globalThis.matchMedia as typeof window.matchMedia
  return {
    setSystem(next: 'light' | 'dark') {
      prefersDark = next === 'dark'
      for (const fn of listeners) fn({ matches: prefersDark })
    },
  }
}

beforeEach(() => {
  installMatchMediaMock('light')
})

afterEach(() => {
  cleanup()
  document.documentElement.classList.remove('dark')
  window.localStorage.clear()
  vi.unstubAllGlobals()
})

describe('readPersistedTheme', () => {
  it('returns the stored value for "dark", "light", or "system" — defaults to "system" when nothing is stored', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    expect(readPersistedTheme()).toBe('dark')
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light')
    expect(readPersistedTheme()).toBe('light')
    window.localStorage.setItem(THEME_STORAGE_KEY, 'system')
    expect(readPersistedTheme()).toBe('system')
    window.localStorage.removeItem(THEME_STORAGE_KEY)
    expect(readPersistedTheme()).toBe('system')
  })
})

describe('resolveTheme', () => {
  it('returns the explicit value for light/dark and follows matchMedia for system', () => {
    expect(resolveTheme('light')).toBe('light')
    expect(resolveTheme('dark')).toBe('dark')
    expect(resolveTheme('system')).toBe('light')
    installMatchMediaMock('dark')
    expect(resolveTheme('system')).toBe('dark')
  })
})

describe('applyThemeClass', () => {
  it('adds "dark" to <html> for dark and removes it for light', () => {
    applyThemeClass('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    applyThemeClass('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })
})

describe('useThemeMode', () => {
  function Probe({ onState }: { onState: (api: ReturnType<typeof useThemeMode>) => void }) {
    const api = useThemeMode()
    onState(api)
    return null
  }

  it('explicit light/dark toggles the dark class and persists the preference', () => {
    let api: ReturnType<typeof useThemeMode> | null = null
    render(<Probe onState={(s) => { api = s }} />)

    // Default is system → light because matchMedia mock returns light.
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(api!.theme).toBe('system')
    expect(api!.resolvedTheme).toBe('light')

    act(() => api!.setTheme('dark'))
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(api!.resolvedTheme).toBe('dark')
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')

    act(() => api!.setTheme('light'))
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(api!.resolvedTheme).toBe('light')
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')
  })

  it('hydrates initial theme from localStorage', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    let api: ReturnType<typeof useThemeMode> | null = null
    render(<Probe onState={(s) => { api = s }} />)
    expect(api!.theme).toBe('dark')
    expect(api!.resolvedTheme).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('system preference follows matchMedia and reacts to OS-level changes', () => {
    const mq = installMatchMediaMock('dark')
    window.localStorage.setItem(THEME_STORAGE_KEY, 'system')
    let api: ReturnType<typeof useThemeMode> | null = null
    render(<Probe onState={(s) => { api = s }} />)

    expect(api!.theme).toBe('system')
    expect(api!.resolvedTheme).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)

    // Simulate the OS flipping to light without touching the persisted preference.
    act(() => mq.setSystem('light'))
    expect(api!.resolvedTheme).toBe('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    // Preference itself is unchanged — the user picked "system", not "light".
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('system')
  })
})
