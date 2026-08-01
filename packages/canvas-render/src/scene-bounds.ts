import type {
  BoundingBox,
  ListItemNode,
  Scene,
  SceneNode,
  TableCellSceneNode,
  TableRowSceneNode,
} from './scene-graph.js'

/**
 * Nodes reachable while walking the scene tree. `ListItemNode`,
 * `TableRowSceneNode`, and `TableCellSceneNode` are not members of the
 * `SceneNode` union (they only ever appear nested under `list`/`table`),
 * but `sceneBounds` still needs to descend into them to find their runs.
 */
type WalkNode = SceneNode | ListItemNode | TableRowSceneNode | TableCellSceneNode

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

/** Children arrays present per node variant, used by the iterative walk. */
function childrenOf(node: WalkNode): readonly WalkNode[] | undefined {
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
      return node.runs
    default:
      return undefined
  }
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
  const stack: WalkNode[] = [...scene.nodes]

  while (stack.length > 0) {
    const node = stack.pop()!

    if (node.kind === 'edge') {
      for (const p of node.path) {
        if (isFinitePoint(p.x, p.y)) {
          extent = widen(extent, p.x, p.y, p.x, p.y)
        }
      }
    } else {
      const edges = bboxEdges(node.bbox)
      if (edges) {
        extent = widen(extent, edges.x0, edges.y0, edges.x1, edges.y1)
      }
    }

    const children = childrenOf(node)
    if (children) stack.push(...children)
  }

  if (!extent) return FALLBACK_BOUNDS

  const w = Math.max(extent.maxX - extent.minX, MIN_SCENE_EXTENT_PX)
  const h = Math.max(extent.maxY - extent.minY, MIN_SCENE_EXTENT_PX)
  return { x: extent.minX, y: extent.minY, w, h }
}
