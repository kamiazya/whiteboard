import { parseMarkdownBody } from '@kamiazya/whiteboard-canvas-codec'
import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-canvas-model'
import type {
  ListItemNode,
  MeasureText,
  Scene,
  SceneNode,
} from '@kamiazya/whiteboard-canvas-render'
import {
  layoutMdastBlocks,
  routeEdge,
  SPATIAL_THEME_FONT_FAMILY,
} from '@kamiazya/whiteboard-canvas-render'

/**
 * Recursively translates every bbox in a scene node subtree by (dx, dy).
 * `layoutMdastBlocks` always starts a document at (0, 0); a spatial
 * canvas's text node lives at its own (x, y), so its laid-out scene must be
 * shifted into place before joining the rest of the canvas's scene graph.
 */
export function translateNode(node: SceneNode, dx: number, dy: number): SceneNode {
  if (node.kind === 'edge') {
    // Edges are already resolved in absolute canvas coordinates by
    // routeEdge — translating them here would double-shift them.
    return node
  }

  const bbox = { x: node.bbox.x + dx, y: node.bbox.y + dy, w: node.bbox.w, h: node.bbox.h }

  switch (node.kind) {
    case 'textRun':
    case 'thematicBreak':
    case 'codeBlock':
    case 'rawHtml':
    case 'unresolvedReference':
    case 'svgFragment':
    case 'embedPlaceholder':
    case 'shape':
    case 'image':
      return { ...node, bbox }
    case 'heading':
    case 'paragraph':
      return {
        ...node,
        bbox,
        runs: node.runs.map((run) => translateNode(run, dx, dy) as typeof run),
      }
    case 'list':
      return {
        ...node,
        bbox,
        items: node.items.map((item) => translateListItem(item, dx, dy)),
      }
    case 'blockquote':
    case 'group':
    case 'embedResolved':
      return { ...node, bbox, children: node.children.map((child) => translateNode(child, dx, dy)) }
    case 'table':
      return {
        ...node,
        bbox,
        rows: node.rows.map((row) => ({
          ...row,
          bbox: { x: row.bbox.x + dx, y: row.bbox.y + dy, w: row.bbox.w, h: row.bbox.h },
          cells: row.cells.map((cell) => ({
            ...cell,
            bbox: { x: cell.bbox.x + dx, y: cell.bbox.y + dy, w: cell.bbox.w, h: cell.bbox.h },
            runs: cell.runs.map((run) => translateNode(run, dx, dy) as typeof run),
          })),
        })),
      }
  }
}

/** `ListItemNode` is not itself a `SceneNode` variant, so it needs its own translator. */
function translateListItem(item: ListItemNode, dx: number, dy: number): ListItemNode {
  return {
    ...item,
    bbox: { x: item.bbox.x + dx, y: item.bbox.y + dy, w: item.bbox.w, h: item.bbox.h },
    children: item.children.map((child) => translateNode(child, dx, dy)),
  }
}

/**
 * `file`/`link`/`group` spatial nodes have no markdown body to lay out.
 * Multi-doc embed recursion (`resolveEmbeds`/`ResolvedDocBundle`) is out of
 * scope for this tool set — these nodes degrade to a placeholder box at
 * their own bbox, matching canvas-render's own "degrade rather than throw"
 * convention (`EmbedPlaceholderNode`).
 */
function placeholderFor(node: SpatialNode): SceneNode {
  return {
    kind: 'group',
    bbox: { x: node.x, y: node.y, w: node.width, h: node.height },
    children: [],
  }
}

function layoutTextNode(node: SpatialNode & { type: 'text' }, measure: MeasureText): SceneNode[] {
  let laidOut: Scene
  try {
    const mdastRoot = parseMarkdownBody(node.text)
    laidOut = layoutMdastBlocks(mdastRoot, {
      measure,
      maxWidth: node.width,
      fontFamily: SPATIAL_THEME_FONT_FAMILY,
    })
  } catch {
    // parseMarkdownBody throws when a body's remark-parsed tree falls
    // outside the closed mdast subset (mdastRootSchema rejects it) — a
    // real, reachable case, not a bug in this composer. Degrade instead of
    // aborting the whole canvas's render for one bad node.
    return [placeholderFor(node)]
  }
  return laidOut.nodes.map((sceneNode) => translateNode(sceneNode, node.x, node.y))
}

/**
 * Composes a full-canvas scene from a `SpatialCanvas`'s independently
 * positioned nodes and edges. Assembling one scene from many per-node
 * layouts is tool-specific composition (not a generic layout function), so
 * it lives here rather than in canvas-render's library surface.
 */
export function composeCanvasScene(canvas: SpatialCanvas, measure: MeasureText): Scene {
  const blockNodes = canvas.nodes.flatMap((node) =>
    node.type === 'text' ? layoutTextNode(node, measure) : [placeholderFor(node)],
  )
  const edgeNodes = canvas.edges.map((edge) =>
    routeEdge(canvas.nodes, edge, canvas['x-whiteboard']?.edgeRouting?.style),
  )
  return { nodes: [...blockNodes, ...edgeNodes] }
}

/**
 * Union bounding box over every top-level node's own geometry — the `<svg>`
 * root's width/height for `wb_scene_render`. An empty canvas has no
 * geometry to union, so it defaults to a zero-sized box rather than an
 * arbitrary sentinel.
 */
export function computeCanvasDimensions(nodes: readonly SpatialNode[]): {
  width: number
  height: number
} {
  if (nodes.length === 0) return { width: 0, height: 0 }

  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const node of nodes) {
    maxX = Math.max(maxX, node.x + node.width)
    maxY = Math.max(maxY, node.y + node.height)
  }
  return { width: maxX, height: maxY }
}
