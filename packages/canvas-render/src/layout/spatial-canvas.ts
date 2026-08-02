// Composes a canvas-render `Scene` from a `SpatialCanvas`. This is the
// single SpatialCanvas -> Scene builder shared by every consumer (Node
// export, the browser viewer) — see package-canvas-render.md's resolved
// decision. Process-internal (a value in, a value out), so per
// zod-schema-discipline no Zod schema is warranted.
//
// A markdown parser is an injected dependency, the same seam class as
// `measure`/`renderMath`: this package never imports canvas-codec, so
// `parseBody` is supplied by the caller (canvas-codec's
// `parseMarkdownBody` in both current consumers). Likewise `appearance` is
// an injected `SpatialAppearanceResolver` (spatial-appearance.ts) — layout
// never chooses a color.
//
// Total by construction: canvas-render's own layout/routing entry points
// already degrade instead of throwing, and this module's one addition —
// calling `parseBody` on a `text` node's body — is wrapped so a markdown
// construct outside the caller's accepted subset degrades that one node's
// content to a literal text run instead of aborting the whole canvas.
//
// Emission order is DOCUMENT order (nodes in array order, shape then
// content per node, then edges), not sorted by position. Z-order is
// authored, not derived, so document order is the correct semantic; a
// (y, x, id) position sort would silently reorder authored z-order. Export
// reproducibility does not need a sort to hold: document order is already
// a total function of a deterministic canvas, so the same canvas renders
// the same SVG twice regardless.
import type { CanvasEdge, SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-canvas-model'
import type { MdastRoot } from '@kamiazya/whiteboard-canvas-model/mdast'
import type { MeasureText } from '../measure.js'
import type {
  ResolvedEdgeNode,
  Scene,
  SceneNode,
  ShapeSceneNode,
  TextRunNode,
} from '../scene-graph.js'
import { layoutMdastBlocks } from './mdast-blocks.js'
import type { SpatialAppearanceResolver } from './spatial-appearance.js'
import { routeEdge } from './spatial-edges.js'
import { translateScene } from './translate-scene.js'

/**
 * A degradation `layoutSpatialCanvas` hit while composing one node, reported
 * only when the caller supplies `onDegrade`. canvas-render itself has no
 * logger (it is a shared layer package with no ambient platform API), so
 * this callback is the observability seam: mcp-server wires it to
 * `getLogger`, canvas-viewer omits it and degrades silently by choice.
 */
export type SpatialLayoutDegradation =
  | { readonly kind: 'body-parse-failed'; readonly nodeId: string; readonly err: unknown }
  | { readonly kind: 'unknown-node-kind'; readonly nodeId: string; readonly type: string }

export interface SpatialLayoutOptions {
  readonly measure: MeasureText
  readonly parseBody: (text: string) => MdastRoot
  readonly appearance: SpatialAppearanceResolver
  readonly onDegrade?: (event: SpatialLayoutDegradation) => void
}

function contentWidth(nodeWidth: number, options: SpatialLayoutOptions): number {
  const width = nodeWidth - 2 * options.appearance.paddingPx
  const floor = options.appearance.minContentWidthPx
  return Number.isFinite(width) && width > floor ? width : floor
}

function chromeShape(node: SpatialNode, options: SpatialLayoutOptions): ShapeSceneNode {
  const resolved = options.appearance.resolveNode(node)
  return {
    kind: 'shape',
    bbox: { x: node.x, y: node.y, w: node.width, h: node.height },
    ...(resolved.radius !== undefined ? { radius: resolved.radius } : {}),
    ...(resolved.appearance !== undefined ? { appearance: resolved.appearance } : {}),
  }
}

/**
 * A label run in CONTENT-ORIGIN-RELATIVE coordinates, matching what
 * `layoutMdastBlocks` produces. Placement is always the caller's job, via
 * `placeInNode`. An absolute-coordinate variant here would be applied
 * twice wherever its output also flows through the translation step.
 */
function labelRun(text: string, options: SpatialLayoutOptions): TextRunNode {
  const labelAppearance = options.appearance.resolveLabel()
  const font = {
    family: labelAppearance.fontFamily ?? 'sans-serif',
    fallbackChain: [],
    weight: 400,
    style: 'normal' as const,
    sizePx: options.appearance.labelFontSizePx,
  }
  const metrics = options.measure(text, font)
  return {
    kind: 'textRun',
    bbox: {
      x: 0,
      y: metrics.ascent,
      w: metrics.advanceWidth,
      h: metrics.ascent + metrics.descent,
    },
    text,
    appearance: { ...labelAppearance, fontSize: options.appearance.labelFontSizePx },
  }
}

/** Moves a node's content from its own origin to the node's padded top-left. */
function placeInNode(
  node: SpatialNode,
  content: Scene,
  options: SpatialLayoutOptions,
): readonly SceneNode[] {
  const padding = options.appearance.paddingPx
  return translateScene(content, node.x + padding, node.y + padding).nodes
}

/**
 * Composes a `text` node's chrome plus its laid-out markdown body. A
 * malformed body (one whose parsed mdast falls outside the caller's
 * accepted subset) degrades to a single literal text run rather than
 * aborting the canvas — this is the layer's own totality addition on top
 * of canvas-render's already-total layout functions.
 */
function composeTextNode(
  node: Extract<SpatialNode, { type: 'text' }>,
  options: SpatialLayoutOptions,
): readonly SceneNode[] {
  const maxWidth = contentWidth(node.width, options)
  let body: Scene
  try {
    const mdast = options.parseBody(node.text)
    body = layoutMdastBlocks(mdast, { measure: options.measure, maxWidth })
  } catch (err) {
    options.onDegrade?.({ kind: 'body-parse-failed', nodeId: node.id, err })
    body = { nodes: [labelRun(node.text, options)] }
  }
  return [chromeShape(node, options), ...placeInNode(node, body, options)]
}

/** The readable label of a non-text node, or `undefined` when it has none. */
function labelOf(
  node: Extract<SpatialNode, { type: 'file' | 'link' | 'group' }>,
): string | undefined {
  switch (node.type) {
    case 'file':
      return node.subpath ? `${node.file}${node.subpath}` : node.file
    case 'link':
      return node.url
    case 'group':
      return node.label && node.label.length > 0 ? node.label : undefined
  }
}

function composeNode(node: SpatialNode, options: SpatialLayoutOptions): readonly SceneNode[] {
  switch (node.type) {
    case 'text':
      return composeTextNode(node, options)
    case 'file':
    case 'link':
    case 'group': {
      const chrome = chromeShape(node, options)
      const label = labelOf(node)
      return label === undefined
        ? [chrome]
        : [chrome, ...placeInNode(node, { nodes: [labelRun(label, options)] }, options)]
    }
    default: {
      // Defensive branch: `SpatialNode` is a closed discriminated union, so
      // this is unreachable for schema-valid input. Kept so an unrecognized
      // `type` (e.g. a value cast past the type system) still degrades to
      // chrome-only rather than throwing.
      const unknownNode = node as SpatialNode
      options.onDegrade?.({
        kind: 'unknown-node-kind',
        nodeId: unknownNode.id,
        type: unknownNode.type,
      })
      return [chromeShape(unknownNode, options)]
    }
  }
}

function composeEdge(
  canvas: SpatialCanvas,
  edge: CanvasEdge,
  options: SpatialLayoutOptions,
): ResolvedEdgeNode {
  // `routeEdge` already degrades a missing endpoint per canvas-render's own
  // documented contract — nothing further to catch here.
  const routed = routeEdge(canvas.nodes, edge)
  const appearance = options.appearance.resolveEdge(edge)
  return appearance === undefined ? routed : { ...routed, appearance }
}

/**
 * The point along `path` used to center an edge's label. Not an exact
 * arc-length midpoint — the midpoint of the two vertices straddling the
 * path's index midpoint — which is exact for the common 2-point straight
 * edge and a stable, deterministic approximation for a multi-point routed
 * path (e.g. a self-edge loop).
 *
 * Returns `undefined` when the path draws no line — fewer than two points,
 * or every point at the same place. `routeEdge`'s missing-endpoint fallback
 * is that second case specifically: it degrades to `[origin, origin]`, a
 * two-point path of zero length. A point-count check alone would miss it and
 * center the label on the canvas origin, leaving text floating with nothing
 * attached to it.
 */
function edgeMidpoint(
  path: readonly { readonly x: number; readonly y: number }[],
): { readonly x: number; readonly y: number } | undefined {
  const first = path[0]
  if (path.length < 2 || first === undefined) return undefined
  if (path.every((p) => p.x === first.x && p.y === first.y)) return undefined
  const mid = (path.length - 1) / 2
  const lower = path[Math.floor(mid)]!
  const upper = path[Math.ceil(mid)]!
  return { x: (lower.x + upper.x) / 2, y: (lower.y + upper.y) / 2 }
}

/**
 * Composes a centered label run for an edge that carries one. Returns
 * `undefined` for no label, an empty/whitespace-only label, or a
 * degenerate path — `layoutSpatialCanvas` stays total either way.
 */
function composeEdgeLabel(
  edge: CanvasEdge,
  routed: ResolvedEdgeNode,
  options: SpatialLayoutOptions,
): TextRunNode | undefined {
  if (edge.label === undefined || edge.label.trim().length === 0) return undefined
  const center = edgeMidpoint(routed.path)
  if (!center) return undefined

  const labelAppearance = options.appearance.resolveLabel()
  const font = {
    family: labelAppearance.fontFamily ?? 'sans-serif',
    fallbackChain: [],
    weight: 400,
    style: 'normal' as const,
    sizePx: options.appearance.labelFontSizePx,
  }
  const metrics = options.measure(edge.label, font)
  const width = metrics.advanceWidth
  const height = metrics.ascent + metrics.descent
  return {
    kind: 'textRun',
    bbox: { x: center.x - width / 2, y: center.y - height / 2, w: width, h: height },
    baseline: metrics.ascent,
    text: edge.label,
    appearance: { ...labelAppearance, fontSize: options.appearance.labelFontSizePx },
  }
}

/**
 * Composes a canvas-render `Scene` from a `SpatialCanvas`. Pure: takes the
 * already-read canvas plus injected measurer/body-parser/appearance, and
 * performs no I/O.
 */
export function layoutSpatialCanvas(canvas: SpatialCanvas, options: SpatialLayoutOptions): Scene {
  const nodeContent = canvas.nodes.flatMap((node) => composeNode(node, options))
  const edgeContent = canvas.edges.map((edge) => composeEdge(canvas, edge, options))
  const labelContent = canvas.edges
    .map((edge, index) => composeEdgeLabel(edge, edgeContent[index]!, options))
    .filter((label): label is TextRunNode => label !== undefined)
  return { nodes: [...nodeContent, ...edgeContent, ...labelContent] }
}
