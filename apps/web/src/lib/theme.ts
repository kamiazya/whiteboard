import type { SpatialThemeMode } from '@kamiazya/whiteboard-canvas-render'

// Stored preference. `'system'` defers to `prefers-color-scheme`, which lets
// users keep the OS setting authoritative without sacrificing manual override.
// The render's own modes plus `'system'`; useThemeMode.test.tsx holds this
// list equal to canvas-render's schema. It is a type-only tie on purpose: this
// module runs before first paint, and a value import of canvas-render's index
// pulls the renderer into the critical path.
export const THEME_MODES = ['light', 'dark', 'system'] as const satisfies readonly (
  | SpatialThemeMode
  | 'system'
)[]
export type ThemeMode = (typeof THEME_MODES)[number]

export function isThemeMode(value: unknown): value is ThemeMode {
  return (THEME_MODES as readonly unknown[]).includes(value)
}

// What actually paints. The `<html class="dark">` switch only understands
// concrete values, so we resolve `'system'` against `matchMedia` before use.
// It is the render's own mode rather than a second spelling of it, so a mode
// canvas-render adds reaches the app's theme plumbing instead of being refused.
export type ResolvedTheme = SpatialThemeMode
