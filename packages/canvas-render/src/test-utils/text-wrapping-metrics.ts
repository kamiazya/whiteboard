import type {
  ListItemNode,
  Scene,
  SceneNode,
  TableCellSceneNode,
  TableRowSceneNode,
  TextRunNode,
} from '../scene-graph.js'

/**
 * The text-wrapping scoreboard's independent oracle.
 *
 * It reads GEOMETRY off the scene and never calls the wrapping code that
 * produced it, so a broken wrap rule cannot satisfy the scoreboard by
 * agreeing with itself (same contract as `routing-metrics.ts`).
 */

/** Sub-pixel slack, so a rounding artefact is not reported as an overflow. */
const EPSILON_PX = 0.01

/**
 * List items, table rows and table cells are reachable from a scene but are
 * NOT members of the `SceneNode` union — they hang off `list.items`,
 * `table.rows` and `tableRow.cells`. A walk typed as `SceneNode` alone stops
 * at the list, which is exactly where the overflowing content is.
 */
type WalkNode = SceneNode | ListItemNode | TableRowSceneNode | TableCellSceneNode

/**
 * The scene graph is NOT uniformly absolute: `listItem` and `tableCell` are
 * the only renderers that emit an SVG `transform`, each translating its
 * subtree by its own `bbox.x`, so their descendants are stored
 * wrapper-RELATIVE. Walking without re-applying that offset under-reports
 * exactly the nested content most likely to overflow. `translate-scene.ts`
 * owns the tripwire test that fails if this set ever changes; a third
 * translating renderer has to be added here too.
 */
function childOffsetX(node: WalkNode): number {
  return node.kind === 'listItem' || node.kind === 'tableCell' ? node.bbox.x : 0
}

function childrenOf(node: WalkNode): readonly WalkNode[] {
  switch (node.kind) {
    case 'heading':
    case 'paragraph':
    case 'tableCell':
      return node.runs
    case 'list':
      return node.items
    case 'listItem':
    case 'blockquote':
    case 'embedResolved':
    case 'group':
      return node.children
    case 'table':
      return node.rows
    case 'tableRow':
      return node.cells
    default:
      return []
  }
}

interface PlacedRun {
  readonly run: TextRunNode
  /** Absolute right edge, with every enclosing wrapper's x re-applied. */
  readonly right: number
}

function collect(nodes: readonly WalkNode[], offsetX: number, out: PlacedRun[]): void {
  for (const node of nodes) {
    if (node.kind === 'textRun') {
      out.push({ run: node, right: offsetX + node.bbox.x + node.bbox.w })
    }
    collect(childrenOf(node), offsetX + childOffsetX(node), out)
  }
}

/**
 * Blocks whose own `bbox` does not cover the ink of the runs inside them.
 * A block that declares `w = maxWidth` while its single run paints twice
 * that far is the reason `sceneBounds`, the export viewBox, and the editor's
 * grow-only auto-fit can all agree on a size nothing actually fits in.
 */
function countBboxUnderreports(nodes: readonly WalkNode[]): number {
  let count = 0
  for (const node of nodes) {
    // An edge carries no bbox; a run is the ink itself, not a container of it.
    if (node.kind === 'textRun' || node.kind === 'edge') continue
    const children = childrenOf(node)
    if (children.length === 0) continue
    const inkRight = Math.max(
      ...children.map((child) => (child.kind === 'edge' ? 0 : child.bbox.x + child.bbox.w)),
    )
    if (inkRight > node.bbox.x + node.bbox.w + EPSILON_PX) count += 1
    count += countBboxUnderreports(children)
  }
  return count
}

/**
 * DEBT metrics target zero. PRICE metrics have no target and exist so a
 * change that buys one with the other cannot do it silently.
 */
export interface WrappingMetrics {
  // debt
  readonly overflowingRuns: number
  readonly maxOverflowPx: number
  readonly bboxUnderreports: number
  // price
  readonly runs: number
  readonly lines: number
  readonly measureCalls: number
}

export function wrappingMetrics(
  scene: Scene,
  maxWidth: number,
  measureCalls: number,
): WrappingMetrics {
  const placed: PlacedRun[] = []
  collect(scene.nodes, 0, placed)
  const overflows = placed
    .map((entry) => entry.right - maxWidth)
    .filter((excess) => excess > EPSILON_PX)
  return {
    overflowingRuns: overflows.length,
    // Rounded: the scoreboard is pinned exactly, and an unrounded float would
    // make every measurer tweak a diff nobody can read.
    maxOverflowPx: overflows.length === 0 ? 0 : Math.round(Math.max(...overflows)),
    bboxUnderreports: countBboxUnderreports(scene.nodes),
    runs: placed.length,
    lines: new Set(placed.map((entry) => entry.run.bbox.y)).size,
    measureCalls,
  }
}

export function sumMetrics(all: readonly WrappingMetrics[]): WrappingMetrics {
  return {
    overflowingRuns: all.reduce((n, m) => n + m.overflowingRuns, 0),
    maxOverflowPx: all.reduce((n, m) => Math.max(n, m.maxOverflowPx), 0),
    bboxUnderreports: all.reduce((n, m) => n + m.bboxUnderreports, 0),
    runs: all.reduce((n, m) => n + m.runs, 0),
    lines: all.reduce((n, m) => n + m.lines, 0),
    measureCalls: all.reduce((n, m) => n + m.measureCalls, 0),
  }
}
