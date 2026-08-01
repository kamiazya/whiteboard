// Composes a canvas-render `Scene` from a persisted `SpatialCanvas`. This is
// process-internal (a value in, a value out) — no process boundary is
// crossed here, so per zod-schema-discipline no Zod schema is warranted;
// every type is imported (`z.infer`-derived at its own source) rather than
// hand-restated.
//
// Total by construction: canvas-render's own layout/routing entry points
// already degrade instead of throwing (see package-canvas-render.md), and
// this module's one addition — `parseMarkdownBody` on a `text` node's body
// — is wrapped so a markdown construct outside the versioned mdast subset
// degrades that one node's content to a literal text run instead of
// aborting the whole canvas.
import { parseMarkdownBody } from '@kamiazya/whiteboard-canvas-codec'
import type { CanvasEdge, SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-canvas-model'
import type {
  MeasureText,
  ResolvedEdgeNode,
  Scene,
  SceneNode,
  ShapeSceneNode,
  TextRunNode,
} from '@kamiazya/whiteboard-canvas-render'
import { layoutMdastBlocks, routeEdge } from '@kamiazya/whiteboard-canvas-render'

import { getLogger } from '../log.js'
import { translateScene } from './scene-transform.js'
import {
  EDGE_APPEARANCE,
  LABEL_APPEARANCE,
  LABEL_FONT_SIZE_PX,
  MIN_CONTENT_WIDTH_PX,
  NODE_CORNER_RADIUS_PX,
  NODE_PADDING_PX,
  SPATIAL_NODE_APPEARANCE,
} from './spatial-scene-appearance.js'

const log = getLogger('export-spatial-scene')

export interface ComposeSpatialSceneOptions {
  readonly measure: MeasureText
}

/** Deterministic total order over spatial nodes: position first, id as the tie-breaker. */
function compareNodesByPosition(a: SpatialNode, b: SpatialNode): number {
  if (a.y !== b.y) return a.y - b.y
  if (a.x !== b.x) return a.x - b.x
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function compareEdgesById(a: CanvasEdge, b: CanvasEdge): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function contentWidth(nodeWidth: number): number {
  const width = nodeWidth - 2 * NODE_PADDING_PX
  return Number.isFinite(width) && width > MIN_CONTENT_WIDTH_PX ? width : MIN_CONTENT_WIDTH_PX
}

function chromeShape(node: SpatialNode): ShapeSceneNode {
  return {
    kind: 'shape',
    bbox: { x: node.x, y: node.y, w: node.width, h: node.height },
    radius: NODE_CORNER_RADIUS_PX,
    appearance: SPATIAL_NODE_APPEARANCE[node.type],
  }
}

function labelRun(node: SpatialNode, text: string, measure: MeasureText): TextRunNode {
  const font = {
    family: LABEL_APPEARANCE.fontFamily ?? 'sans-serif',
    fallbackChain: [],
    weight: 400,
    style: 'normal' as const,
    sizePx: LABEL_FONT_SIZE_PX,
  }
  const metrics = measure(text, font)
  return {
    kind: 'textRun',
    bbox: {
      x: node.x + NODE_PADDING_PX,
      y: node.y + NODE_PADDING_PX + metrics.ascent,
      w: metrics.advanceWidth,
      h: metrics.ascent + metrics.descent,
    },
    text,
    appearance: { ...LABEL_APPEARANCE, fontSize: LABEL_FONT_SIZE_PX },
  }
}

/**
 * Composes a `text` node's chrome plus its laid-out markdown body. A
 * malformed body (one whose parsed mdast falls outside the versioned
 * subset `parseMarkdownBody` accepts) degrades to a single literal text
 * run rather than aborting the canvas — this is the layer's own totality
 * addition on top of canvas-render's already-total layout functions.
 */
function composeTextNode(
  node: Extract<SpatialNode, { type: 'text' }>,
  measure: MeasureText,
): readonly SceneNode[] {
  const maxWidth = contentWidth(node.width)
  let body: Scene
  try {
    const mdast = parseMarkdownBody(node.text)
    body = layoutMdastBlocks(mdast, { measure, maxWidth })
  } catch (err) {
    log.warning(
      { nodeId: node.id, err },
      'text node body failed to parse as markdown; falling back to literal text',
    )
    body = {
      nodes: [labelRun(node, node.text, measure)],
    }
  }
  const placed = translateScene(body, node.x + NODE_PADDING_PX, node.y + NODE_PADDING_PX)
  return [chromeShape(node), ...placed.nodes]
}

function composeFileNode(
  node: Extract<SpatialNode, { type: 'file' }>,
  measure: MeasureText,
): readonly SceneNode[] {
  const label = node.subpath ? `${node.file}${node.subpath}` : node.file
  return [chromeShape(node), labelRun(node, label, measure)]
}

function composeLinkNode(
  node: Extract<SpatialNode, { type: 'link' }>,
  measure: MeasureText,
): readonly SceneNode[] {
  return [chromeShape(node), labelRun(node, node.url, measure)]
}

function composeGroupNode(
  node: Extract<SpatialNode, { type: 'group' }>,
  measure: MeasureText,
): readonly SceneNode[] {
  const chrome = chromeShape(node)
  if (!node.label || node.label.length === 0) return [chrome]
  return [chrome, labelRun(node, node.label, measure)]
}

function composeNode(node: SpatialNode, measure: MeasureText): readonly SceneNode[] {
  switch (node.type) {
    case 'text':
      return composeTextNode(node, measure)
    case 'file':
      return composeFileNode(node, measure)
    case 'link':
      return composeLinkNode(node, measure)
    case 'group':
      return composeGroupNode(node, measure)
    default: {
      // Defensive branch: `SpatialNode` is a closed discriminated union, so
      // this is unreachable for schema-valid input. Kept so an unrecognized
      // `type` (e.g. a value cast past the type system) still degrades to
      // chrome-only rather than throwing.
      const unknownNode = node as SpatialNode
      log.warning(
        { nodeId: unknownNode.id, type: unknownNode.type },
        'unrecognized spatial node kind; emitting chrome only',
      )
      return [chromeShape(unknownNode)]
    }
  }
}

function composeEdge(canvas: SpatialCanvas, edge: CanvasEdge): ResolvedEdgeNode {
  // `routeEdge` already degrades a missing endpoint per canvas-render's own
  // documented contract (package-canvas-render.md) — nothing further to
  // catch here.
  return { ...routeEdge(canvas.nodes, edge), appearance: EDGE_APPEARANCE }
}

/**
 * Composes a canvas-render `Scene` from a persisted `SpatialCanvas`. Pure:
 * takes the already-read canvas plus an injected text measurer, and
 * performs no I/O. Node emission order is a total function of canvas
 * content (position then id), never of input array or object-key
 * iteration order — see `compareNodesByPosition`.
 */
export function composeSpatialScene(
  canvas: SpatialCanvas,
  options: ComposeSpatialSceneOptions,
): Scene {
  const sortedNodes = [...canvas.nodes].sort(compareNodesByPosition)
  const sortedEdges = [...canvas.edges].sort(compareEdgesById)

  const nodeContent = sortedNodes.flatMap((node) => composeNode(node, options.measure))
  const edgeContent = sortedEdges.map((edge) => composeEdge(canvas, edge))

  return { nodes: [...nodeContent, ...edgeContent] }
}
