/**
 * A thin adapter from this app's `ResolvedTheme` to canvas-render's shared
 * `createSpatialTheme` (package-canvas-render.md decision #8). Every
 * appearance/geometry decision now lives in canvas-render's theme layer —
 * this file exists only to translate this app's theme-mode type and to
 * expose the one caller that needs a single value rather than a whole
 * resolver (`SpatialEditor`'s host-element text fill).
 *
 * This is NOT a separate resolver: `createEditorAppearance` calls straight
 * into `createSpatialTheme`. Export (mcp-server) and the read-only viewer
 * (canvas-viewer) both call `createSpatialTheme({ mode: 'light' })`
 * directly for the same reason this file is pinned to light on export (see
 * `useDocumentSync.ts`'s `exportScene`) — a user's UI theme must never change
 * exported SVG/PNG bytes.
 */
import {
  createSpatialTheme,
  SPATIAL_DARK_PALETTE,
  SPATIAL_LIGHT_PALETTE,
  type SpatialAppearanceResolver,
} from '@kamiazya/whiteboard-canvas-render'
import type { ResolvedTheme } from '../../lib/theme.js'
// Backward-compatible view of the shared palettes in the shape this
// package's own tests already assert (`chromeStroke`/`textFill`). The
// shared palette differentiates node FILL per type, but stroke and label
// fill each stay one accessible value per mode (see
// package-canvas-render.md decision #8), so this projection loses nothing
// the contrast test needs.
export const EDITOR_LIGHT_PALETTE = {
  chromeStroke: SPATIAL_LIGHT_PALETTE.edgeStroke,
  textFill: SPATIAL_LIGHT_PALETTE.labelFill,
}

export const EDITOR_DARK_PALETTE = {
  chromeStroke: SPATIAL_DARK_PALETTE.edgeStroke,
  textFill: SPATIAL_DARK_PALETTE.labelFill,
}

const PALETTES: Readonly<Record<ResolvedTheme, { chromeStroke: string; textFill: string }>> = {
  light: EDITOR_LIGHT_PALETTE,
  dark: EDITOR_DARK_PALETTE,
}

export function createEditorAppearance(theme: ResolvedTheme): SpatialAppearanceResolver {
  return createSpatialTheme({ mode: theme })
}

/**
 * The theme's text color, for the one caller that needs a single value rather
 * than a whole resolver: `SpatialEditor`'s host element sets it as the SVG
 * `fill` markdown body runs inherit (canvas-render assigns them none).
 */
export function editorTextFill(theme: ResolvedTheme): string {
  return PALETTES[theme].textFill
}
