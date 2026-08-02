// The appearance seam for `layoutSpatialCanvas` (spatial-canvas.ts).
// canvas-render's layout functions deliberately never invent a fill/stroke/
// font (see `Appearance` in scene-graph.ts) — that decision belongs to the
// theme layer (`../theme/spatial-theme.ts`'s `createSpatialTheme`, the ONE
// producer of this interface; see package-canvas-render.md decision #8). A
// resolver is a set of FUNCTIONS rather than a static per-kind record
// because appearance keys off both `node.type` and an authored
// `node.color`/`x-whiteboard` hint. No default resolver is exported here —
// appearance stays assigned, not invented.
//
// This interface is APPEARANCE-ONLY. It deliberately has no
// paddingPx/labelFontSizePx/minContentWidthPx: those are geometry, not
// appearance, and geometry must not vary by which resolver a surface
// happens to use (see `../theme/spatial-geometry.ts` and the
// `spatial-geometry-parity.test.ts` guard). A caller that wants a
// non-default geometry passes `SpatialLayoutOptions.geometry` explicitly at
// the call site, never through this resolver.
import type { CanvasEdge, SpatialNode } from '@kamiazya/whiteboard-canvas-model'
import type { Appearance } from '../scene-graph.js'

/** What a resolver decided for one spatial node's chrome. */
export interface SpatialNodeAppearance {
  readonly appearance?: Appearance
  /** Uniform corner radius for the chrome shape; omitted means no radius. */
  readonly radius?: number
}

export interface SpatialAppearanceResolver {
  resolveNode(node: SpatialNode): SpatialNodeAppearance
  resolveEdge(edge: CanvasEdge): Appearance | undefined
  /** Appearance for a `file`/`link`/`group` label run or a degraded body fallback run. */
  resolveLabel(): Appearance
}
