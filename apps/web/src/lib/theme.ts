import type { SpatialThemeMode } from '@kamiazya/whiteboard-canvas-render'

// Stored preference. `'system'` defers to `prefers-color-scheme`, which lets
// users keep the OS setting authoritative without sacrificing manual override.
export type ThemeMode = 'light' | 'dark' | 'system'

// What actually paints. The `<html class="dark">` switch only understands
// concrete values, so we resolve `'system'` against `matchMedia` before use.
// It is the render's own mode rather than a second spelling of it, so a mode
// canvas-render adds reaches the app's theme plumbing instead of being refused.
export type ResolvedTheme = SpatialThemeMode
