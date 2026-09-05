// Stored preference. `'system'` defers to `prefers-color-scheme`, which lets
// users keep the OS setting authoritative without sacrificing manual override.
export type ThemeMode = 'light' | 'dark' | 'system'

// What actually paints. The `<html class="dark">` switch only understands
// concrete values, so we resolve `'system'` against `matchMedia` before use.
export type ResolvedTheme = 'light' | 'dark'
