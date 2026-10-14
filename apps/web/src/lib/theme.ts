import { type SpatialThemeMode, spatialThemeModeSchema } from '@kamiazya/whiteboard-canvas-render'
import { z } from 'zod'

// Stored preference. `'system'` defers to `prefers-color-scheme`, which lets
// users keep the OS setting authoritative without sacrificing manual override.
// Built from the render's own modes, so a mode canvas-render adds is one a
// user can pick and a stored value that names it survives a reload.
export const themeModeSchema = z.enum([...spatialThemeModeSchema.options, 'system'])
export type ThemeMode = z.infer<typeof themeModeSchema>

// What actually paints. The `<html class="dark">` switch only understands
// concrete values, so we resolve `'system'` against `matchMedia` before use.
// It is the render's own mode rather than a second spelling of it, so a mode
// canvas-render adds reaches the app's theme plumbing instead of being refused.
export type ResolvedTheme = SpatialThemeMode
