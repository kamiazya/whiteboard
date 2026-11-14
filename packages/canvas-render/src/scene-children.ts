import type {
  ListItemNode,
  SceneNode,
  TableCellSceneNode,
  TableRowSceneNode,
} from '@kamiazya/whiteboard-scene'

/**
 * Nodes reachable while walking the scene tree. `ListItemNode`,
 * `TableRowSceneNode`, and `TableCellSceneNode` are not members of the
 * `SceneNode` union (they only ever appear nested under `list`/`table`),
 * but `sceneBounds` still needs to descend into them to find their runs.
 */
export type SceneWalkNode = SceneNode | ListItemNode | TableRowSceneNode | TableCellSceneNode

/**
 * What a scene node holds, per variant — the one definition of how a scene
 * nests, read by `sceneBounds`, `collectTextRuns` and every other walk.
 * A leaf, so a layout stage below `scene-bounds` can read it too.
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

/**
 * The x-shift a node applies to its own subtree. `renderListItem` and
 * `renderTableCell` are the only renderers that emit a transform, and both
 * translate by their own `bbox.x` on the x axis only — so their descendants
 * are stored in wrapper-relative coordinates, and every walk that wants where
 * they are DRAWN (`sceneBounds`, the passage highlights) adds this back,
 * nested wrappers composing. Every other wrapper emits a plain `<g>`, leaving
 * its children absolute. A non-finite `bbox.x` contributes no shift rather
 * than poisoning the whole subtree with NaN.
 */
export function subtreeOffsetX(node: SceneWalkNode): number {
  if (node.kind !== 'listItem' && node.kind !== 'tableCell') return 0
  return Number.isFinite(node.bbox.x) ? node.bbox.x : 0
}
