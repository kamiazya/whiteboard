// The appearance seam for `layoutSpatialCanvas` (spatial-canvas.ts).
// canvas-render's layout functions deliberately never invent a fill/stroke/
// font (see `Appearance` in scene-graph.ts) — that decision belongs to the
// composition root until the theme layer (Phase 4) lands. A resolver is a
// set of FUNCTIONS rather than a static per-kind record because the two
// current consumers key appearance differently: mcp-server's export chrome
// keys off `node.type` alone, while canvas-viewer derives fill from
// `node.color` (JSON Canvas presets) and radius from
// `node['x-whiteboard'].shape === 'ellipse'`. Functions subsume both without
// a union type and without losing either consumer's behavior. No default
// resolver is exported here — appearance stays assigned, not invented.
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
  /** Uniform padding (px) between a node's box edge and its laid-out content. */
  readonly paddingPx: number
  /** Font size (px) used for label runs. */
  readonly labelFontSizePx: number
  /** Floor for a node's derived content width, so padding never drives it negative. */
  readonly minContentWidthPx: number
}
