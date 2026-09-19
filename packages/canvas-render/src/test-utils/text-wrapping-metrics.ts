import type {
  ListItemNode,
  Scene,
  SceneNode,
  TableCellSceneNode,
  TableRowSceneNode,
  TextRunNode,
} from '@kamiazya/whiteboard-scene'

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
  /** Absolute left edge, for deciding which run OPENS a line. */
  readonly left: number
  /** Which block laid this run out, so one block's first line is not read as
   * a break in another's. */
  readonly block: number
}

function collect(
  nodes: readonly WalkNode[],
  offsetX: number,
  out: PlacedRun[],
  block: number,
): void {
  for (const node of nodes) {
    if (node.kind === 'textRun') {
      out.push({
        run: node,
        right: offsetX + node.bbox.x + node.bbox.w,
        left: offsetX + node.bbox.x,
        block,
      })
      continue
    }
    // A container of runs is a block for this purpose: its own first line has
    // no break before it, whatever character it starts with.
    const inner = 'runs' in node ? block + 1 + out.length : block
    collect(childrenOf(node), offsetX + childOffsetX(node), out, inner)
  }
}

/**
 * Characters UAX #14 will not put at the start of a line — the closing and
 * infix-separator classes, in both the CJK and the ASCII forms this corpus
 * uses.
 *
 * Written out rather than asked of `css-line-break`, which is what the
 * WRAPPER uses: an oracle sharing its subject's machinery agrees with its
 * mistakes by construction, the failure `routing-metrics.ts` and
 * `polyline-geometry.independence.test.ts` are each shaped to avoid.
 */
const NEVER_OPENS_A_LINE = new Set([
  ...'。、，．！？：；',
  ...'」』）］｝〉》〕】〙〗”’',
  ...'.,!?:;)]}',
])

/**
 * Lines opened by one of those characters — a break placed where the source
 * offers none.
 *
 * A block's FIRST line is exempt: nothing was broken before it, so a
 * paragraph that genuinely begins with a full stop is the author's text
 * rather than a wrapping defect.
 */
function countForbiddenLineStarts(placed: readonly PlacedRun[]): number {
  const opener = new Map<string, PlacedRun>()
  const topOf = new Map<number, number>()
  for (const entry of placed) {
    const y = entry.run.bbox.y
    const key = `${entry.block}@${y}`
    const current = opener.get(key)
    if (current === undefined || entry.left < current.left) opener.set(key, entry)
    const top = topOf.get(entry.block)
    if (top === undefined || y < top) topOf.set(entry.block, y)
  }
  let count = 0
  for (const entry of opener.values()) {
    if (entry.run.bbox.y === topOf.get(entry.block)) continue
    const first = [...entry.run.text][0]
    if (first !== undefined && NEVER_OPENS_A_LINE.has(first)) count += 1
  }
  return count
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
  readonly forbiddenLineStarts: number
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
  collect(scene.nodes, 0, placed, 0)
  const overflows = placed
    .map((entry) => entry.right - maxWidth)
    .filter((excess) => excess > EPSILON_PX)
  return {
    overflowingRuns: overflows.length,
    // Rounded: the scoreboard is pinned exactly, and an unrounded float would
    // make every measurer tweak a diff nobody can read.
    maxOverflowPx: overflows.length === 0 ? 0 : Math.round(Math.max(...overflows)),
    bboxUnderreports: countBboxUnderreports(scene.nodes),
    forbiddenLineStarts: countForbiddenLineStarts(placed),
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
    forbiddenLineStarts: all.reduce((n, m) => n + m.forbiddenLineStarts, 0),
    runs: all.reduce((n, m) => n + m.runs, 0),
    lines: all.reduce((n, m) => n + m.lines, 0),
    measureCalls: all.reduce((n, m) => n + m.measureCalls, 0),
  }
}
