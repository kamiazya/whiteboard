import type {
  BoundingBox,
  ListItemNode,
  Scene,
  SceneInk,
  SceneNode,
  TableCellSceneNode,
  TableRowSceneNode,
} from '@kamiazya/whiteboard-scene'
import { edgeArrowPolygons } from './edge-arrows.js'
import { glowReachPx } from './layout/ink/glow.js'
import { SKETCH_INK_REACH_PX } from './layout/ink/sketch.js'
import { LEGEND_MARGIN_PX, legendPanelSize } from './legend/legend-geometry.js'

/**
 * Nodes reachable while walking the scene tree. `ListItemNode`,
 * `TableRowSceneNode`, and `TableCellSceneNode` are not members of the
 * `SceneNode` union (they only ever appear nested under `list`/`table`),
 * but `sceneBounds` still needs to descend into them to find their runs.
 */
export type SceneWalkNode = SceneNode | ListItemNode | TableRowSceneNode | TableCellSceneNode

/**
 * The minimum extent (px) any axis of a `sceneBounds` result is clamped to.
 * A zero-area viewBox is what resvg degenerates on, so a collapsed axis
 * (all-zero-size content, collinear edge points) is widened to this value
 * rather than emitted as-is. Consumers (mcp-server, canvas-viewer) can rely
 * on this exact constant when reasoning about the document envelope.
 */
export const MIN_SCENE_EXTENT_PX = 1

/**
 * The bounds returned for a scene that contributes no finite geometry at
 * all (empty scene, or every bbox/point non-finite). Also part of the
 * public degenerate-fallback contract.
 */
const FALLBACK_BOUNDS: BoundingBox = { x: 0, y: 0, w: 1, h: 1 }

interface Extent {
  readonly minX: number
  readonly minY: number
  readonly maxX: number
  readonly maxY: number
}

function isFinitePoint(x: number, y: number): boolean {
  return Number.isFinite(x) && Number.isFinite(y)
}

/** Returns a new extent covering `extent` plus the given edge pair; a null extent seeds from the pair. */
function widen(extent: Extent | null, x0: number, y0: number, x1: number, y1: number): Extent {
  if (!extent) return { minX: x0, minY: y0, maxX: x1, maxY: y1 }
  return {
    minX: Math.min(extent.minX, x0),
    minY: Math.min(extent.minY, y0),
    maxX: Math.max(extent.maxX, x1),
    maxY: Math.max(extent.maxY, y1),
  }
}

/** Normalizes a bbox's possibly-negative w/h into a min/max edge pair. Non-finite input is skipped by the caller. */
function bboxEdges(bbox: BoundingBox): { x0: number; y0: number; x1: number; y1: number } | null {
  const { x, y, w, h } = bbox
  if (![x, y, w, h].every(Number.isFinite)) return null
  const cornerX = x + w
  const cornerY = y + h
  return {
    x0: Math.min(x, cornerX),
    y0: Math.min(y, cornerY),
    x1: Math.max(x, cornerX),
    y1: Math.max(y, cornerY),
  }
}

/**
 * The x-shift a node applies to its own subtree. `renderListItem` and
 * `renderTableCell` are the only renderers that emit a transform, and both
 * translate by their own `bbox.x` on the x axis only — so their descendants
 * are stored in wrapper-relative coordinates and must be re-offset here to
 * land where they are actually drawn. Every other wrapper emits a plain
 * `<g>`, leaving its children absolute. A non-finite `bbox.x` contributes no
 * shift rather than poisoning the whole subtree with NaN.
 */
function subtreeOffsetX(node: SceneWalkNode): number {
  if (node.kind !== 'listItem' && node.kind !== 'tableCell') return 0
  return Number.isFinite(node.bbox.x) ? node.bbox.x : 0
}

/**
 * What a scene node holds, per variant — the one definition of how a scene
 * nests, read by this walk and by `collectTextRuns`.
 */
export function sceneChildrenOf(node: SceneWalkNode): readonly SceneWalkNode[] | undefined {
  switch (node.kind) {
    case 'blockquote':
    case 'group':
    case 'embedResolved':
    case 'listItem':
      return node.children
    case 'list':
      return node.items
    case 'table':
      return node.rows
    case 'tableRow':
      return node.cells
    case 'heading':
    case 'paragraph':
    case 'tableCell':
    // A fenced block's runs are optional — absent when its whole value
    // renders as one `<text>` — and `undefined` is already what this
    // function says for a node with no children.
    case 'codeBlock':
      return node.runs
    default:
      return undefined
  }
}

const inkReach = (ink: SceneInk | undefined): number =>
  ink?.style === 'sketch' ? SKETCH_INK_REACH_PX : 0

/**
 * How far a node's DECORATION reaches beyond its own geometry: ink is
 * bounded by a declared constant (ADR-0038 decision #10) and a glow by its
 * radius, so an inked or glowing node widens the envelope by exactly that
 * much and a derived viewBox never clips either. Nothing else moves.
 */
function decorationReachPx(node: SceneWalkNode): number {
  return Math.max(
    node.kind === 'edge' || node.kind === 'shape' ? inkReach(node.ink) : 0,
    'appearance' in node ? glowReachPx(node.appearance?.glow?.radiusPx ?? 0) : 0,
  )
}

/**
 * What an EDGE contributes: its polyline, plus the arrowhead wings, which
 * reach beyond the polyline's own envelope. The wings come from the shared
 * geometry helper so this walk agrees with what the SVG backend draws, and
 * they take no reach of their own — the stroke's does not apply to a filled
 * polygon's own points.
 */
function widenByEdgePath(
  extent: Extent | null,
  node: Extract<SceneNode, { kind: 'edge' }>,
  offsetX: number,
  reach: number,
): Extent | null {
  let next = extent
  for (const p of node.path) {
    if (!isFinitePoint(p.x, p.y)) continue
    const x = p.x + offsetX
    next = widen(next, x - reach, p.y - reach, x + reach, p.y + reach)
  }
  for (const arrow of edgeArrowPolygons(node)) {
    for (const p of arrow.points) {
      if (!isFinitePoint(p.x, p.y)) continue
      const x = p.x + offsetX
      next = widen(next, x, p.y, x, p.y)
    }
  }
  return next
}

/**
 * What a BOXED node contributes: its own bbox, widened by its decoration.
 * An edge is excluded by TYPE rather than by a guard — it is the one variant
 * with no bbox, and its points are `widenByEdgePath`'s.
 */
function widenByNodeBox(
  extent: Extent | null,
  node: Exclude<SceneWalkNode, { kind: 'edge' }>,
  offsetX: number,
  reach: number,
): Extent | null {
  const edges = bboxEdges(node.bbox)
  if (!edges) return extent
  return widen(
    extent,
    edges.x0 + offsetX - reach,
    edges.y0 - reach,
    edges.x1 + offsetX + reach,
    edges.y1 + reach,
  )
}

/**
 * Computes the union bbox of every resolved node bbox in the scene,
 * including edge polyline points, walked at every depth (not just
 * top-level) with an explicit stack so a pathologically deep embed chain
 * cannot overflow the call stack.
 *
 * Total: an empty scene, an all-zero-size scene, or a scene with only
 * non-finite geometry all yield the documented fallback/clamped result
 * rather than NaN/Infinity/a zero-area box — see MIN_SCENE_EXTENT_PX and
 * FALLBACK_BOUNDS.
 */
export function sceneBounds(scene: Scene): BoundingBox {
  let extent: Extent | null = null
  // Each frame carries the accumulated x-shift of its ancestors' transforms,
  // so nested wrappers compose exactly as nested `<g transform>` elements do.
  const stack: { node: SceneWalkNode; offsetX: number }[] = scene.nodes.map((node) => ({
    node,
    offsetX: 0,
  }))

  while (stack.length > 0) {
    const { node, offsetX } = stack.pop()!
    const reach = decorationReachPx(node)
    extent =
      node.kind === 'edge'
        ? widenByEdgePath(extent, node, offsetX, reach)
        : widenByNodeBox(extent, node, offsetX, reach)

    const children = sceneChildrenOf(node)
    if (children) {
      const childOffsetX = offsetX + subtreeOffsetX(node)
      for (const child of children) stack.push({ node: child, offsetX: childOffsetX })
    }
  }

  if (!extent) return FALLBACK_BOUNDS

  const w = Math.max(extent.maxX - extent.minX, MIN_SCENE_EXTENT_PX)
  const h = Math.max(extent.maxY - extent.minY, MIN_SCENE_EXTENT_PX)
  return { x: extent.minX, y: extent.minY, w, h }
}

/**
 * The box a DOCUMENT of this scene is drawn in: the scene's bounds, plus a
 * band on the left for the legend when the scene carries one (ADR-0040
 * decision 6), so the legend the backend draws in the top-left corner
 * covers no content. Without the band the legend sat over the first box of
 * every tagged board. The band is the legend's estimated panel plus its
 * margins; the scene's own bounds — what the digest, the drawing score and
 * the editor read — are untouched, so a legend never moves an instrument.
 */
export function sceneDocumentBounds(scene: Scene): BoundingBox {
  const bounds = sceneBounds(scene)
  if (scene.legend === undefined) return bounds
  const panel = legendPanelSize(scene.legend)
  if (panel.w === 0) return bounds
  const band = panel.w + LEGEND_MARGIN_PX * 2
  return {
    x: bounds.x - band,
    y: bounds.y,
    w: bounds.w + band,
    h: Math.max(bounds.h, panel.h + LEGEND_MARGIN_PX * 2),
  }
}
