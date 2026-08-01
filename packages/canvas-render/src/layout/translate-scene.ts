// Pure scene -> scene translation. `layoutMdastBlocks` always lays out a
// block tree relative to its own origin (its top-level nodes start at y = 0,
// `x` = 0 or a list-depth offset) — placing that output at a spatial node's
// absolute position requires shifting the whole tree by the node's (x, y).
//
// The x axis needs special care. `renderListItem`/`renderTableCell` (the SVG
// backend, `svg/backend.ts`) are the only renderers that emit
// `transform="translate(bbox.x,0)"` — everything below such a wrapper is
// stored **wrapper-relative** on x. Shifting every bbox.x by the same dx
// would double-shift that subtree: once via the wrapper's own bbox.x (which
// feeds directly into its transform), and again via each descendant's
// already-relative bbox.x. So x is only shifted down to (and including) the
// nearest such wrapper; everything further nested keeps its stored x
// untouched. y carries no such wrapper transform anywhere in the backend, so
// it is always shifted unconditionally, at every depth.
//
// This mirrors `scene-bounds.ts`'s `subtreeOffsetX`/`childrenOf` walk
// exactly, because both functions must agree on which nodes are
// x-transform boundaries — see the tripwire test in translate-scene.test.ts.
import type {
  BoundingBox,
  ListItemNode,
  Scene,
  SceneNode,
  TableCellSceneNode,
  TableRowSceneNode,
  TextRunNode,
} from '../scene-graph.js'

type TranslatableNode = SceneNode | ListItemNode | TableRowSceneNode | TableCellSceneNode

function translateBbox(bbox: BoundingBox, dx: number, dy: number): BoundingBox {
  return { x: bbox.x + dx, y: bbox.y + dy, w: bbox.w, h: bbox.h }
}

/**
 * `true` when `node` is a wrapper that emits its own x transform in the SVG
 * backend — its children's stored `bbox.x` is relative to that wrapper and
 * must NOT receive an additional x shift.
 */
function isXTransformBoundary(node: TranslatableNode): boolean {
  return node.kind === 'listItem' || node.kind === 'tableCell'
}

/**
 * Translates one node (and, if it has children, its whole subtree) by
 * `(dx, dy)`. `shiftX` is `false` once the walk has passed an
 * x-transform-boundary wrapper, and stays `false` for every node beneath
 * it, however deep — matching `scene-bounds.ts`'s `offsetX` accumulation.
 */
function translateNode(
  node: TranslatableNode,
  dx: number,
  dy: number,
  shiftX: boolean,
): TranslatableNode {
  const appliedDx = shiftX ? dx : 0
  const childShiftX = shiftX && !isXTransformBoundary(node)

  if (node.kind === 'edge') {
    return {
      ...node,
      path: node.path.map((point) => ({ x: point.x + appliedDx, y: point.y + dy })),
    }
  }

  const bbox = translateBbox(node.bbox, appliedDx, dy)
  const translateChild = (child: TranslatableNode): TranslatableNode =>
    translateNode(child, dx, dy, childShiftX)

  switch (node.kind) {
    case 'blockquote':
    case 'group':
    case 'embedResolved':
    case 'listItem':
      return { ...node, bbox, children: node.children.map(translateChild) as readonly SceneNode[] }
    case 'heading':
    case 'paragraph':
    case 'tableCell':
      return { ...node, bbox, runs: node.runs.map(translateChild) as readonly TextRunNode[] }
    case 'list':
      return { ...node, bbox, items: node.items.map(translateChild) as readonly ListItemNode[] }
    case 'table':
      return { ...node, bbox, rows: node.rows.map(translateChild) as readonly TableRowSceneNode[] }
    case 'tableRow':
      return {
        ...node,
        bbox,
        cells: node.cells.map(translateChild) as readonly TableCellSceneNode[],
      }
    default:
      return { ...node, bbox }
  }
}

/** Translates an entire scene by `(dx, dy)`, preserving every non-geometric field. */
export function translateScene(scene: Scene, dx: number, dy: number): Scene {
  return {
    nodes: scene.nodes.map((node) => translateNode(node, dx, dy, true) as SceneNode),
  }
}
