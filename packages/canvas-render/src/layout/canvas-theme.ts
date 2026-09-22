/**
 * WHICH theme a canvas is drawn in, and what it resolves to — the palette an
 * editor chrome previews, the family a tool echoes, and the active theme and
 * face one level of the layout applies (ADR-0030). Resolution only: applying
 * it to the layout options is `withCanvasTheme`, in `spatial-canvas.ts`,
 * because it also re-derives the silhouettes that module owns.
 */

import type { ThemeTokens } from '@kamiazya/whiteboard-facet-engine'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { visualRenderContribution } from '@kamiazya/whiteboard-plugin-visual/render'
import type { RenderContribution } from '@kamiazya/whiteboard-scene'
import { SPATIAL_THEME_FONT_FAMILY } from '../theme/font-family.js'
import {
  SPATIAL_DARK_PALETTE,
  SPATIAL_LIGHT_PALETTE,
  type SpatialPalette,
} from '../theme/spatial-palette.js'
import type { SpatialThemeMode } from '../theme/spatial-theme.js'
import { paletteFromTokens } from '../theme/theme-asset.js'
import type { ResolvedLayoutOptions, SpatialRenderStyle } from './layout-options.js'

/** The theme a canvas names for itself: the first contribution that reads one. */
function ownThemeId(
  canvas: SpatialCanvas,
  contributions: readonly RenderContribution[],
): string | undefined {
  return contributions
    .map((contribution) => contribution.readTheme?.(canvas))
    .find((id) => id !== undefined)
}

/** The composed theme table a contribution set resolves to, by namespaced id. */
export function resolveThemeTable(
  contributions: readonly RenderContribution[],
): Readonly<Record<string, ThemeTokens>> {
  const table: Record<string, ThemeTokens> = {}
  for (const contribution of contributions) {
    for (const [name, tokens] of Object.entries(contribution.themes ?? {})) {
      table[`${contribution.namespace}.${name}`] = tokens
    }
  }
  return table
}

/**
 * The palette ONE canvas is drawn in under a style — the theme the style
 * resolves to (`pickThemeId`: the canvas's own under `'document'`, a named
 * one, none under `'clean'`), for the mode, else the bundled palette for
 * that mode. `style` defaults to `'document'`, the editor's look.
 *
 * For an editor chrome that previews paint rather than painting: the paper
 * under the canvas, and a colour picker's swatches showing the strokes a
 * pick will produce. Resolved here so the preview and the layout read the
 * same table AND the same style; a chrome reading the saved theme while
 * the session draws clean showed neon's night under a clean board.
 */
export function resolveCanvasPalette(
  canvas: SpatialCanvas,
  mode: SpatialThemeMode,
  options: {
    readonly style?: SpatialRenderStyle
    readonly contributions?: readonly RenderContribution[]
  } = {},
): SpatialPalette {
  const contributions = options.contributions ?? [visualRenderContribution]
  const own = ownThemeId(canvas, contributions)
  const themeId = pickThemeId(options.style ?? 'document', own, undefined)
  const tokens = themeId === undefined ? undefined : resolveThemeTable(contributions)[themeId]
  if (tokens === undefined) return mode === 'dark' ? SPATIAL_DARK_PALETTE : SPATIAL_LIGHT_PALETTE
  return paletteFromTokens(tokens.palette[mode])
}

/**
 * The family the theme this canvas draws in NAMES, or nothing — the style
 * resolves to no theme, or the theme declares no family of its own.
 *
 * Separate from `resolveCanvasPalette` in ONE way that matters: an absent
 * `style` is `'clean'` here, not `'document'`. A palette is asked for by a
 * surface already drawing the document; this is asked by a tool ECHOING a
 * caller's `style`, where absent means the bundled look and so nothing for
 * the caller to go and fetch.
 */
export function resolveCanvasThemeFontFamily(
  canvas: SpatialCanvas,
  options: {
    readonly style?: SpatialRenderStyle
    readonly contributions?: readonly RenderContribution[]
  } = {},
): string | undefined {
  const contributions = options.contributions ?? [visualRenderContribution]
  const own = ownThemeId(canvas, contributions)
  const themeId = pickThemeId(options.style, own, undefined)
  const tokens = themeId === undefined ? undefined : resolveThemeTable(contributions)[themeId]
  return tokens?.fontFamily
}

/**
 * The theme id a canvas draws in, under the style the caller asked for:
 * `'clean'` never has one; a theme id IS one; `'document'` takes the
 * canvas's own, else the host's (an embed inherits), else none.
 */
function pickThemeId(
  style: SpatialRenderStyle | undefined,
  own: string | undefined,
  inherited: string | undefined,
): string | undefined {
  if (style === undefined || style === 'clean') return undefined
  if (style === 'document') return own ?? inherited
  return style
}

/**
 * WHICH theme one canvas is drawn in: the canvas's own, the inherited one, or
 * none, as the style decides — reporting a named theme this build does not
 * carry, which then draws clean.
 */
export function canvasTheme(
  canvas: SpatialCanvas,
  resolved: ResolvedLayoutOptions,
): ResolvedLayoutOptions['activeTheme'] {
  const own = ownThemeId(canvas, resolved.contributions)
  const themeId = pickThemeId(resolved.style, own, resolved.activeTheme?.id)
  if (themeId === undefined) return undefined
  const tokens = resolved.themeTable[themeId]
  if (tokens === undefined) {
    resolved.onDegrade?.({ kind: 'unknown-theme', theme: themeId })
    return undefined
  }
  return { id: themeId, tokens }
}

/**
 * The family a theme's text is DECLARED in: the one it names when this
 * surface holds that face, and the bundled one otherwise — reporting the face
 * it had to replace. The declared family must be the measured one.
 */
export function themeFace(wanted: string | undefined, resolved: ResolvedLayoutOptions): string {
  if (wanted === undefined) return SPATIAL_THEME_FONT_FAMILY
  const available = resolved.fontAvailable ?? ((family) => family === SPATIAL_THEME_FONT_FAMILY)
  if (available(wanted)) return wanted
  resolved.onDegrade?.({ kind: 'font-missing', family: wanted })
  return SPATIAL_THEME_FONT_FAMILY
}
