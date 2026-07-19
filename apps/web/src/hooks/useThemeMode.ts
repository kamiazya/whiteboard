import { useCallback, useEffect, useState } from 'react'

// Stored preference. `'system'` defers to `prefers-color-scheme`, which lets
// users keep the OS setting authoritative without sacrificing manual override.
export type ThemeMode = 'light' | 'dark' | 'system'

// What actually paints. Excalidraw and `<html class="dark">` only understand
// concrete values, so we resolve `'system'` against `matchMedia` before use.
export type ResolvedTheme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'whiteboard:theme'

const SYSTEM_QUERY = '(prefers-color-scheme: dark)'

// localStorage access itself can throw (SecurityError when the browser blocks
// storage via privacy settings or embedded/sandboxed contexts). Theme
// persistence is a nice-to-have, not a correctness requirement, so a throwing
// storage degrades to an in-memory-only "system" default rather than crashing
// render.
function safeGetItem(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function safeSetItem(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Contract: never throws; an unwritable storage just loses persistence.
  }
}

// Read the persisted preference without triggering a render. Safe to call from
// module init (main.tsx) so we set <html class="dark"> before React mounts and
// avoid a flash on cold load.
export function readPersistedTheme(): ThemeMode {
  if (typeof window === 'undefined') return 'system'
  const stored = safeGetItem(THEME_STORAGE_KEY)
  if (stored === 'dark' || stored === 'light' || stored === 'system') return stored
  return 'system'
}

function getSystemTheme(): ResolvedTheme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'light'
  return window.matchMedia(SYSTEM_QUERY).matches ? 'dark' : 'light'
}

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  return mode === 'system' ? getSystemTheme() : mode
}

// Tailwind v4 + shadcn rely on `.dark` on an ancestor — we put it on <html>
// so every child route (Index, Canvas, dialogs portalled to body) inherits
// the dark variables.
export function applyThemeClass(resolved: ResolvedTheme): void {
  if (typeof document === 'undefined') return
  document.documentElement.classList.toggle('dark', resolved === 'dark')
}

export function useThemeMode(): {
  theme: ThemeMode
  resolvedTheme: ResolvedTheme
  setTheme: (next: ThemeMode) => void
} {
  const [theme, setThemeState] = useState<ThemeMode>(() => readPersistedTheme())
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => resolveTheme(theme))

  // Re-resolve whenever the preference changes. For `'system'` also subscribe
  // to OS-level flips so the UI follows along without a reload.
  useEffect(() => {
    if (theme !== 'system') {
      setResolvedTheme(theme)
      return
    }
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      setResolvedTheme('light')
      return
    }
    const mql = window.matchMedia(SYSTEM_QUERY)
    const update = (e: { matches: boolean }) => setResolvedTheme(e.matches ? 'dark' : 'light')
    update(mql)
    mql.addEventListener('change', update)
    return () => mql.removeEventListener('change', update)
  }, [theme])

  useEffect(() => {
    applyThemeClass(resolvedTheme)
  }, [resolvedTheme])

  useEffect(() => {
    if (typeof window !== 'undefined') {
      safeSetItem(THEME_STORAGE_KEY, theme)
    }
  }, [theme])

  const setTheme = useCallback((next: ThemeMode) => setThemeState(next), [])

  return { theme, resolvedTheme, setTheme }
}
