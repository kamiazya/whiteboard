// Pure scene -> scene uniform scaling about the origin, the multiplicative
// sibling of `translateScene`. Composing a resolved child canvas into a
// parent file-node's box is scale-then-translate: lay the child out at its
// native size, scale it to fit, then shift it to the node's position.
//
// Unlike translation, scaling needs NO x-transform-boundary special case:
// `renderListItem`/`renderTableCell` children store x RELATIVE to their
// wrapper, and uniform scaling about the origin commutes with that
// representation (f*(wrapper + relative) = f*wrapper + f*relative), so
// every coordinate at every depth simply multiplies by the factor.
//
// Size-bearing paint fields scale with the geometry (fontSize, strokeWidth,
// shape radius, textRun baseline) so a scaled scene renders as a uniform
// miniature, not as full-weight strokes on shrunken boxes. Two documented
// non-scaling cases: an `svgFragment`'s verbatim SVG string cannot be
// scaled here (only its bbox is — a fragment inside a scaled embed renders
// at its authored size), and edge arrowheads are derived by the backend
// from the scaled path with fixed canvas-unit sizing, so they come out
// relatively larger inside a miniature. Both are acceptable for embed
// rendering and pinned by tests rather than hidden.
import type {
  Appearance,
  BoundingBox,
  ListItemNode,
  Scene,
  SceneNode,
  TableCellSceneNode,
  TableRowSceneNode,
} from '../scene-graph.js'

type ScalableNode = SceneNode | ListItemNode | TableRowSceneNode | TableCellSceneNode

function scaleBbox(bbox: BoundingBox, f: number): BoundingBox {
  return { x: bbox.x * f, y: bbox.y * f, w: bbox.w * f, h: bbox.h * f }
}

function scaleAppearance(appearance: Appearance | undefined, f: number): Appearance | undefined {
  if (appearance === undefined) return undefined
  const next: Appearance = {
    ...appearance,
    ...(appearance.fontSize !== undefined ? { fontSize: appearance.fontSize * f } : {}),
    ...(appearance.strokeWidth !== undefined ? { strokeWidth: appearance.strokeWidth * f } : {}),
  }
  return next
}

function scaleNode(node: ScalableNode, f: number): ScalableNode {
  switch (node.kind) {
    case 'edge':
      return {
        ...node,
        path: node.path.map((point) => ({ x: point.x * f, y: point.y * f })),
        ...(node.jumps !== undefined
          ? { jumps: node.jumps.map((jump) => ({ ...jump, x: jump.x * f, y: jump.y * f })) }
          : {}),
        appearance: scaleAppearance(node.appearance, f),
      }
    case 'textRun':
      return {
        ...node,
        bbox: scaleBbox(node.bbox, f),
        ...(node.baseline !== undefined ? { baseline: node.baseline * f } : {}),
        appearance: scaleAppearance(node.appearance, f),
      }
    case 'shape':
      return {
        ...node,
        bbox: scaleBbox(node.bbox, f),
        ...(node.radius !== undefined ? { radius: node.radius * f } : {}),
        appearance: scaleAppearance(node.appearance, f),
      }
    case 'heading':
    case 'paragraph':
      return {
        ...node,
        bbox: scaleBbox(node.bbox, f),
        runs: node.runs.map((r) => scaleNode(r, f) as never),
      }
    case 'list':
      return {
        ...node,
        bbox: scaleBbox(node.bbox, f),
        items: node.items.map((item) => scaleNode(item, f) as ListItemNode),
      }
    case 'listItem':
      return {
        ...node,
        bbox: scaleBbox(node.bbox, f),
        children: node.children.map((child) => scaleNode(child, f) as SceneNode),
      }
    case 'table':
      return {
        ...node,
        bbox: scaleBbox(node.bbox, f),
        rows: node.rows.map((row) => scaleNode(row, f) as TableRowSceneNode),
      }
    case 'tableRow':
      return {
        ...node,
        bbox: scaleBbox(node.bbox, f),
        cells: node.cells.map((cell) => scaleNode(cell, f) as TableCellSceneNode),
      }
    case 'tableCell':
      return {
        ...node,
        bbox: scaleBbox(node.bbox, f),
        runs: node.runs.map((r) => scaleNode(r, f) as never),
      }
    case 'blockquote':
    case 'embedResolved':
    case 'group':
      return {
        ...node,
        bbox: scaleBbox(node.bbox, f),
        children: node.children.map((child) => scaleNode(child, f) as SceneNode),
      } as ScalableNode
    default:
      // codeBlock, thematicBreak, rawHtml, unresolvedReference,
      // svgFragment, embedPlaceholder: bbox-only nodes (their string
      // payloads render verbatim — see the module comment).
      return { ...node, bbox: scaleBbox(node.bbox, f) }
  }
}

/**
 * Scales every coordinate in the scene by `factor` about the origin.
 * Total: `factor` 1 is the identity; a non-finite or non-positive factor
 * returns the input scene unchanged rather than producing degenerate
 * geometry.
 */
export function scaleScene(scene: Scene, factor: number): Scene {
  if (!Number.isFinite(factor) || factor <= 0) return scene
  if (factor === 1) return scene
  return { nodes: scene.nodes.map((node) => scaleNode(node, factor) as SceneNode) }
}
