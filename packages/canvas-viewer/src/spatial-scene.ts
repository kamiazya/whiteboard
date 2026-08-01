import { parseMarkdownBody } from '@kamiazya/whiteboard-canvas-codec'
import type { CanvasColor, SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-canvas-model'
import {
  layoutMdastBlocks,
  type MeasureText,
  routeEdge,
  type Scene,
  type SceneNode,
  type ShapeSceneNode,
  type TextRunNode,
} from '@kamiazya/whiteboard-canvas-render'
import { VIEWER_FONT_FAMILY } from './font.js'

/**
 * NOTE: this is a viewer-local SpatialCanvas -> canvas-render Scene builder.
 * No shared builder exists yet anywhere in the repo (mcp-server's exporter
 * still targets its own pre-OpenCanvas scene shape), so this is a promotion
 * candidate to canvas-render once a second consumer needs the same logic —
 * keep it pure/self-contained so that move stays mechanical.
 */

const CONTENT_PADDING_PX = 8
const CONTENT_FONT_SIZE_PX = 16

// JSON Canvas 1.0's six numbered color presets, approximated as hex so this
// package's Appearance (canvas-render's optional paint attributes) can carry
// a concrete fill without canvas-render ever having to know about presets.
const PRESET_COLOR_HEX: Readonly<Record<string, string>> = {
  '1': '#e03131',
  '2': '#e8590c',
  '3': '#f08c00',
  '4': '#2f9e44',
  '5': '#1971c2',
  '6': '#9c36b5',
}

function resolvePresetOrHex(color: CanvasColor | undefined): string | undefined {
  if (color === undefined) return undefined
  return color.startsWith('#') ? color : PRESET_COLOR_HEX[color]
}

// SVG's own default fill for an unstyled <rect> is solid black, and
// canvas-render's SVG backend never invents an appearance default (see
// package-canvas-render.md decision #6: omit, never default). A colorless
// spatial node therefore needs an explicit transparent fill here, or every
// node without an authored `color` would render as an opaque black box.
// This default is shape-only: an edge with no authored color keeps
// `resolvePresetOrHex`'s `undefined` so it falls through to the SVG
// backend's own (visible, black) default line stroke.
const NO_FILL = 'none'

function resolveShapeFill(color: CanvasColor | undefined): string {
  return resolvePresetOrHex(color) ?? NO_FILL
}

function shapeRadius(node: SpatialNode): number | undefined {
  const extension = node['x-whiteboard']
  if (extension?.kind === 'shape' && extension.shape === 'ellipse') {
    return Math.min(node.width, node.height) / 2
  }
  return undefined
}

/** The box chrome of a spatial node: rect bbox plus the optional radius/fill it resolved to. */
function buildShapeNode(node: SpatialNode): ShapeSceneNode {
  const radius = shapeRadius(node)
  const fill = resolveShapeFill(node.color)
  return {
    kind: 'shape',
    bbox: { x: node.x, y: node.y, w: node.width, h: node.height },
    ...(radius !== undefined ? { radius } : {}),
    appearance: { fill },
  }
}

interface Box {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

function shiftBox(box: Box, dx: number, dy: number): Box {
  return { x: box.x + dx, y: box.y + dy, w: box.w, h: box.h }
}

function translateTextRun(run: TextRunNode, dx: number, dy: number): TextRunNode {
  return { ...run, bbox: shiftBox(run.bbox, dx, dy) }
}

/** Recursively shifts every bbox (and edge path point) in a scene node by (dx, dy). */
function translateSceneNode(node: SceneNode, dx: number, dy: number): SceneNode {
  switch (node.kind) {
    case 'textRun':
      return translateTextRun(node, dx, dy)
    case 'heading':
    case 'paragraph':
      return {
        ...node,
        bbox: shiftBox(node.bbox, dx, dy),
        runs: node.runs.map((run) => translateTextRun(run, dx, dy)),
      }
    case 'list':
      return {
        ...node,
        bbox: shiftBox(node.bbox, dx, dy),
        items: node.items.map((item) => ({
          ...item,
          bbox: shiftBox(item.bbox, dx, dy),
          children: item.children.map((child) => translateSceneNode(child, dx, dy)),
        })),
      }
    case 'blockquote':
    case 'group':
    case 'embedResolved':
      return {
        ...node,
        bbox: shiftBox(node.bbox, dx, dy),
        children: node.children.map((child) => translateSceneNode(child, dx, dy)),
      }
    case 'table':
      return {
        ...node,
        bbox: shiftBox(node.bbox, dx, dy),
        rows: node.rows.map((row) => ({
          ...row,
          bbox: shiftBox(row.bbox, dx, dy),
          cells: row.cells.map((cell) => ({
            ...cell,
            bbox: shiftBox(cell.bbox, dx, dy),
            runs: cell.runs.map((run) => translateTextRun(run, dx, dy)),
          })),
        })),
      }
    case 'shape':
    case 'codeBlock':
    case 'thematicBreak':
    case 'rawHtml':
    case 'unresolvedReference':
    case 'svgFragment':
    case 'embedPlaceholder':
      return { ...node, bbox: shiftBox(node.bbox, dx, dy) }
    case 'edge':
      return { ...node, path: node.path.map((p) => ({ x: p.x + dx, y: p.y + dy })) }
  }
}

/** The padded top-left corner a node's content (label or laid-out markdown) starts at. */
function contentOrigin(node: SpatialNode): { readonly x: number; readonly y: number } {
  return { x: node.x + CONTENT_PADDING_PX, y: node.y + CONTENT_PADDING_PX }
}

/** A single text run at the node's content origin — used for file/link/group node labels. */
function labelTextRun(text: string, node: SpatialNode): TextRunNode {
  const origin = contentOrigin(node)
  return {
    kind: 'textRun',
    bbox: { x: origin.x, y: origin.y, w: 0, h: CONTENT_FONT_SIZE_PX },
    text,
    appearance: { fontFamily: VIEWER_FONT_FAMILY, fontSize: CONTENT_FONT_SIZE_PX },
  }
}

function buildTextNodeContent(
  node: Extract<SpatialNode, { type: 'text' }>,
  measure: MeasureText,
): readonly SceneNode[] {
  if (node.text === '') return []
  // Total function: markdown parsing/layout never throws by contract for
  // any string, but degrade to a plain label rather than propagate on the
  // (documented-impossible-but-unproven) chance a malformed body slips
  // through the pipeline's own schema validation.
  try {
    const root = parseMarkdownBody(node.text)
    const scene = layoutMdastBlocks(root, {
      measure,
      maxWidth: Math.max(node.width - CONTENT_PADDING_PX * 2, 0),
    })
    const origin = contentOrigin(node)
    return scene.nodes.map((n) => translateSceneNode(n, origin.x, origin.y))
  } catch {
    return [labelTextRun(node.text, node)]
  }
}

function buildNodeContent(node: SpatialNode, measure: MeasureText): readonly SceneNode[] {
  switch (node.type) {
    case 'text':
      return buildTextNodeContent(node, measure)
    case 'file':
      return [labelTextRun(node.file, node)]
    case 'link':
      return [labelTextRun(node.url, node)]
    case 'group':
      return node.label ? [labelTextRun(node.label, node)] : []
  }
}

/**
 * Builds a canvas-render Scene from a SpatialCanvas. Deterministic emission
 * order: nodes in document order (shape then content per node), then edges —
 * z-order is document order, deliberately NOT sorted/order-independent, so
 * paint order matches authoring order. Total: never throws, degrades on
 * missing endpoints / empty text / zero-size boxes (canvas-render already
 * guarantees its half of that contract).
 */
export function buildViewerScene(canvas: SpatialCanvas, measure: MeasureText): Scene {
  const nodes: SceneNode[] = []

  for (const node of canvas.nodes) {
    nodes.push(buildShapeNode(node))
    nodes.push(...buildNodeContent(node, measure))
  }

  for (const edge of canvas.edges) {
    const resolved = routeEdge(canvas.nodes, edge)
    const stroke = resolvePresetOrHex(edge.color)
    nodes.push(stroke === undefined ? resolved : { ...resolved, appearance: { stroke } })
  }

  return { nodes }
}
