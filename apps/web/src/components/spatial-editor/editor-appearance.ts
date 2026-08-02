/**
 * The spatial editor's `SpatialAppearanceResolver` (canvas-render's
 * `layoutSpatialCanvas` appearance seam). Colors are keyed by the app's
 * resolved theme (`useThemeMode`'s `ResolvedTheme`) so node chrome, edges,
 * and labels stay visible against both the light and dark canvas surface —
 * canvas-render never chooses a color itself (appearance is assigned, not
 * invented), so theme resolution lives here, in the composition root.
 *
 * This resolver is NOT shared with canvas-viewer's `VIEWER_APPEARANCE` or
 * mcp-server's export appearance — each consumer owns its own file, and
 * export is deliberately pinned to the light palette (see
 * `useCanvasSync.ts`'s `exportScene`) so a user's UI theme can never change
 * exported SVG/PNG bytes.
 *
 * No Zod schema here: the palette never crosses a process boundary — only
 * the SVG string canvas-render serializes does, and that serializer already
 * owns escaping. Per YAGNI this stays plain TS.
 */
import type { SpatialAppearanceResolver } from '@kamiazya/whiteboard-canvas-render'
import type { ResolvedTheme } from '../../hooks/useThemeMode.js'

const CONTENT_PADDING_PX = 8
const CONTENT_FONT_SIZE_PX = 16
const CHROME_FILL = 'none'

interface EditorPalette {
  readonly chromeStroke: string
  readonly textFill: string
}

// Light keeps the pre-existing values byte-identical to the prior
// single-constant implementation.
export const EDITOR_LIGHT_PALETTE: EditorPalette = {
  chromeStroke: '#333333',
  textFill: '#333333',
}

// Dark is a deliberate palette, not `#333333` inverted — a desaturated cool
// gray reads better against the app's dark canvas surface
// (`oklch(0.145 0 0)`, see index.css's `--background`) than a harsh
// near-white/near-black inversion. Values are pinned as data so the
// contrast test (editor-appearance-contrast.test.ts) reviews them as
// numbers, not by eye.
export const EDITOR_DARK_PALETTE: EditorPalette = {
  chromeStroke: '#9BA3AF',
  textFill: '#E6E8EB',
}

function buildResolver(palette: EditorPalette): SpatialAppearanceResolver {
  return {
    resolveNode: () => ({ appearance: { fill: CHROME_FILL, stroke: palette.chromeStroke } }),
    resolveEdge: () => ({ stroke: palette.chromeStroke }),
    resolveLabel: () => ({ fill: palette.textFill }),
    paddingPx: CONTENT_PADDING_PX,
    labelFontSizePx: CONTENT_FONT_SIZE_PX,
    minContentWidthPx: 0,
  }
}

const PALETTES: Readonly<Record<ResolvedTheme, EditorPalette>> = {
  light: EDITOR_LIGHT_PALETTE,
  dark: EDITOR_DARK_PALETTE,
}

// Frozen module-level singletons (one per theme), not built per call: a
// fresh object identity every render would churn `SpatialEditor`'s
// `useMemo` deps and re-render its SVG on every frame.
const RESOLVERS: Readonly<Record<ResolvedTheme, SpatialAppearanceResolver>> = Object.freeze({
  light: Object.freeze(buildResolver(PALETTES.light)),
  dark: Object.freeze(buildResolver(PALETTES.dark)),
})

export function createEditorAppearance(theme: ResolvedTheme): SpatialAppearanceResolver {
  return RESOLVERS[theme]
}

/**
 * The theme's text color, for the one caller that needs a single value rather
 * than a whole resolver: `SpatialEditor`'s host element sets it as the SVG
 * `fill` markdown body runs inherit (canvas-render assigns them none).
 */
export function editorTextFill(theme: ResolvedTheme): string {
  return PALETTES[theme].textFill
}
