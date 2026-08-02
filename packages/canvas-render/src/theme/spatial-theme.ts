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
import type { CanvasColor, CanvasEdge, SpatialNode } from '@kamiazya/whiteboard-canvas-model'
import type { SpatialAppearanceResolver } from '../layout/spatial-appearance.js'
import type { Appearance } from '../scene-graph.js'
import { SPATIAL_THEME_FONT_FAMILY } from './font-family.js'
import {
  SPATIAL_DARK_PALETTE,
  SPATIAL_LIGHT_PALETTE,
  type SpatialPalette,
} from './spatial-palette.js'

export type SpatialThemeMode = 'light' | 'dark'

export interface SpatialThemeOptions {
  readonly mode: SpatialThemeMode
}

// JSON Canvas 1.0's six numbered color presets, approximated as hex so this
// theme's Appearance output can carry a concrete fill/stroke without
// canvas-render ever having to know about presets.
const PRESET_COLOR_HEX: Readonly<Record<string, string>> = {
  '1': '#e03131',
  '2': '#e8590c',
  '3': '#f08c00',
  '4': '#2f9e44',
  '5': '#1971c2',
  '6': '#9c36b5',
}

function resolvePresetOrHex(color: CanvasColor | undefined): string | undefined {
  if (color === undefined) return undefined
  return color.startsWith('#') ? color : PRESET_COLOR_HEX[color]
}

function shapeRadius(node: SpatialNode, palette: SpatialPalette): number {
  const extension = node['x-whiteboard']
  if (extension?.kind === 'shape' && extension.shape === 'ellipse') {
    return Math.min(node.width, node.height) / 2
  }
  return palette.cornerRadiusPx
}

function buildTheme(palette: SpatialPalette): SpatialAppearanceResolver {
  return {
    resolveNode: (node: SpatialNode) => {
      // `palette.node` is keyed by `SpatialNode['type']`'s closed union;
      // the fallback only fires for a value cast past the type system
      // (`layoutSpatialCanvas`'s own defensive `unknown-node-kind` branch),
      // keeping this resolver total rather than throwing on a bad node.
      const style = palette.node[node.type] ?? palette.node.text
      const appearance: Appearance = {
        fill: resolvePresetOrHex(node.color) ?? style.fill,
        stroke: style.stroke,
      }
      return { radius: shapeRadius(node, palette), appearance }
    },
    resolveEdge: (edge: CanvasEdge) => ({
      stroke: resolvePresetOrHex(edge.color) ?? palette.edgeStroke,
    }),
    resolveLabel: () => ({ fill: palette.labelFill, fontFamily: SPATIAL_THEME_FONT_FAMILY }),
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
  return THEMES[options.mode]
}
