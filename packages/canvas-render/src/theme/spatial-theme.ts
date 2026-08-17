// The ONE `SpatialAppearanceResolver` producer (package-canvas-render.md
// decision #8), replacing three independently-grown per-surface resolvers
// (apps/web's editor-appearance.ts, canvas-viewer's viewer-appearance.ts,
// mcp-server's spatial-scene-appearance.ts).
//
// Dark mode is a PARAMETER of this one theme, not a second appearance
// authority layered on top:
//   - a scene->scene dark transform would still need semantic role
//     knowledge (which node is which type, which edge/label is which), so
//     it would be strictly more machinery for the same result while
//     reintroducing exactly the multi-producer divergence this file exists
//     to delete;
//   - the editor's dark palette already exists and is contrast-tested
//     (see spatial-palette.ts), so it has to survive regardless;
//   - the viewer and export call sites both pin `mode: 'light'`, preserving
//     the pre-existing invariant that a user's UI theme can never change
//     exported bytes.
// Not fixed here: `headless-renderer`'s `theme: 'dark'` option still only
// changes the document background, so a dark export pairs a dark
// background with light node chrome — changing that is a behavior decision
// (export gaining a dark chrome variant), not a convergence one, and is
// out of this slice's scope.
import type { CanvasColor, CanvasEdge, SpatialNode } from '@kamiazya/whiteboard-model'
import type { SpatialAppearanceResolver } from '../layout/spatial-appearance.js'
import type { Appearance } from '../scene-graph.js'
import { SPATIAL_THEME_FONT_FAMILY } from './font-family.js'
import {
  SPATIAL_DARK_PALETTE,
  SPATIAL_LIGHT_PALETTE,
  type SpatialPalette,
  type SpatialPresetAccent,
} from './spatial-palette.js'

export type SpatialThemeMode = 'light' | 'dark'

export interface SpatialThemeOptions {
  readonly mode: SpatialThemeMode
  /**
   * Wholesale palette replacement — the theme layer's swap point. Presets,
   * chrome colors, and geometry-adjacent values (corner radius) all come
   * from the palette, so restyling is a data change, never a resolver
   * change. Callers providing a palette get a freshly built resolver each
   * call and own its memoization (the per-mode defaults stay frozen
   * singletons).
   */
  readonly palette?: SpatialPalette
}

/** A numbered preset resolved through the palette; null for hex/unknown. */
function presetAccent(color: CanvasColor | undefined, palette: SpatialPalette) {
  if (color === undefined || color.startsWith('#')) return null
  return (palette.presets as Partial<Record<string, SpatialPresetAccent>>)[color] ?? null
}

/** An author-supplied raw hex, passed through untouched; undefined otherwise. */
function rawHex(color: CanvasColor | undefined): string | undefined {
  return color?.startsWith('#') ? color : undefined
}

function buildTheme(palette: SpatialPalette): SpatialAppearanceResolver {
  return {
    resolveNode: (node: SpatialNode) => {
      // `palette.node` is keyed by `SpatialNode['type']`'s closed union;
      // the fallback only fires for a value cast past the type system
      // (`layoutSpatialCanvas`'s own defensive `unknown-node-kind` branch),
      // keeping this resolver total rather than throwing on a bad node.
      const style = palette.node[node.type] ?? palette.node.text
      // Preset: accent STROKE + tint FILL (body text keeps the theme text
      // color — readability never depends on the accent hue). Raw hex: the
      // author's exact fill, unchanged (their own responsibility).
      const accent = presetAccent(node.color, palette)
      const appearance: Appearance =
        accent !== null
          ? { fill: accent.fill, stroke: accent.stroke }
          : { fill: rawHex(node.color) ?? style.fill, stroke: style.stroke }
      return { radius: palette.cornerRadiusPx, appearance }
    },
    resolveEdge: (edge: CanvasEdge) => ({
      stroke: presetAccent(edge.color, palette)?.stroke ?? rawHex(edge.color) ?? palette.edgeStroke,
    }),
    resolveLabel: () => ({
      fill: palette.labelFill,
      fontFamily: SPATIAL_THEME_FONT_FAMILY,
      halo: palette.surface,
    }),
  }
}

// Frozen module-level singletons (one per mode), not built per call: a
// fresh resolver object every call would churn `SpatialEditor`'s `useMemo`
// deps and re-render its SVG on every frame.
const THEMES: Readonly<Record<SpatialThemeMode, SpatialAppearanceResolver>> = Object.freeze({
  light: Object.freeze(buildTheme(SPATIAL_LIGHT_PALETTE)),
  dark: Object.freeze(buildTheme(SPATIAL_DARK_PALETTE)),
})

export function createSpatialTheme(options: SpatialThemeOptions): SpatialAppearanceResolver {
  if (options.palette !== undefined) return buildTheme(options.palette)
  return THEMES[options.mode]
}
