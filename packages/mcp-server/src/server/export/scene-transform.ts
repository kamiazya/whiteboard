// Pure scene -> scene translation. `layoutMdastBlocks` (canvas-render)
// always lays out a block tree relative to its own origin (its top-level
// nodes start at y = 0, `x` = 0 or a list-depth offset) — placing that
// output at a spatial node's absolute position requires shifting the whole
// tree by the node's (x, y).
//
// The x axis needs special care. `renderListItem`/`renderTableCell` (the
// SVG backend, canvas-render's svg/backend.ts) are the only renderers that
// emit `transform="translate(bbox.x,0)"` — everything below such a wrapper
// is stored **wrapper-relative** on x. Shifting every bbox.x by the same
// dx would double-shift that subtree: once via the wrapper's own bbox.x
// (which feeds directly into its transform), and again via each
// descendant's already-relative bbox.x. So x is only shifted down to (and
// including) the nearest such wrapper; everything further nested keeps its
// stored x untouched. y carries no such wrapper transform anywhere in the
// backend, so it is always shifted unconditionally, at every depth.
//
// This mirrors scene-bounds.ts's `subtreeOffsetX`/`childrenOf` walk
// exactly, because both functions must agree on which nodes are
// x-transform boundaries — see the tripwire test in spatial-scene.test.ts.
import type {
  BlockquoteNode,
  BoundingBox,
  EmbedResolvedNode,
  GroupSceneNode,
  ListBlockNode,
  ListItemNode,
  Scene,
  SceneNode,
  TableBlockNode,
  TableCellSceneNode,
  TableRowSceneNode,
} from '@kamiazya/whiteboard-canvas-render'

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

  switch (node.kind) {
    case 'blockquote': {
      const blockquote = node as BlockquoteNode
      return {
        ...blockquote,
        bbox,
        children: blockquote.children.map((child) =>
          translateNode(child, dx, dy, childShiftX),
        ) as readonly SceneNode[],
      }
    }
    case 'group': {
      const group = node as GroupSceneNode
      return {
        ...group,
        bbox,
        children: group.children.map((child) =>
          translateNode(child, dx, dy, childShiftX),
        ) as readonly SceneNode[],
      }
    }
    case 'embedResolved': {
      const embed = node as EmbedResolvedNode
      return {
        ...embed,
        bbox,
        children: embed.children.map((child) =>
          translateNode(child, dx, dy, childShiftX),
        ) as readonly SceneNode[],
      }
    }
    case 'listItem': {
      const listItem = node as ListItemNode
      return {
        ...listItem,
        bbox,
        children: listItem.children.map((child) =>
          translateNode(child, dx, dy, childShiftX),
        ) as readonly SceneNode[],
      }
    }
    case 'list': {
      const list = node as ListBlockNode
      return {
        ...list,
        bbox,
        items: list.items.map((item) => translateNode(item, dx, dy, childShiftX) as ListItemNode),
      }
    }
    case 'table': {
      const table = node as TableBlockNode
      return {
        ...table,
        bbox,
        rows: table.rows.map((row) => translateNode(row, dx, dy, childShiftX) as TableRowSceneNode),
      }
    }
    case 'tableRow': {
      const row = node as TableRowSceneNode
      return {
        ...row,
        bbox,
        cells: row.cells.map(
          (cell) => translateNode(cell, dx, dy, childShiftX) as TableCellSceneNode,
        ),
      }
    }
    case 'tableCell': {
      const cell = node as TableCellSceneNode
      return {
        ...cell,
        bbox,
        runs: cell.runs.map((run) => translateNode(run, dx, dy, childShiftX)),
      } as TableCellSceneNode
    }
    case 'heading':
    case 'paragraph': {
      return {
        ...node,
        bbox,
        runs: node.runs.map((run) => translateNode(run, dx, dy, childShiftX)),
      } as SceneNode
    }
    default:
      return { ...node, bbox } as TranslatableNode
  }
}

/** Translates an entire scene by `(dx, dy)`, preserving every non-geometric field. */
export function translateScene(scene: Scene, dx: number, dy: number): Scene {
  return {
    nodes: scene.nodes.map((node) => translateNode(node, dx, dy, true) as SceneNode),
  }
}
