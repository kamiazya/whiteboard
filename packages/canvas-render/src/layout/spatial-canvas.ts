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
import { sceneBounds } from '../scene-bounds.js'
import type {
  ResolvedEdgeNode,
  Scene,
  SceneNode,
  ShapeSceneNode,
  TextRunNode,
} from '../scene-graph.js'
import { SPATIAL_THEME_GEOMETRY, type SpatialGeometry } from '../theme/spatial-geometry.js'
import { layoutMdastBlocks } from './mdast-blocks.js'
import { scaleScene } from './scale-scene.js'
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
  // 'repeat' tiling needs the image's intrinsic size, which this pure layer
  // never has (no image decoding behind the resolveFileImage seam) — it
  // renders as 'cover' and the caller is told.
  | {
      readonly kind: 'unsupported-background-style'
      readonly nodeId: string
      readonly style: 'repeat'
    }

export interface SpatialLayoutOptions {
  readonly measure: MeasureText
  readonly parseBody: (text: string) => MdastRoot
  readonly appearance: SpatialAppearanceResolver
  /**
   * Geometry constants (padding/label font size/min content width).
   * Defaults to `SPATIAL_THEME_GEOMETRY` — the shared constant every
   * surface must agree on (package-canvas-render.md decision #8). Omit
   * this in every ordinary call site; a caller that must diverge has to
   * pass an explicit override here, never inside `appearance`, so a
   * divergence is a reviewable one-line diff instead of a silent per-file
   * constant.
   */
  readonly geometry?: SpatialGeometry
  readonly onDegrade?: (event: SpatialLayoutDegradation) => void
  /**
   * Human-readable label for a file node's reference. A composition root
   * whose file references are opaque ids (the browser-local store) resolves
   * them to titles here; `undefined` (or a throw — total-layout rule) falls
   * back to the raw reference string. Absent in exports that have no
   * resolver, so exported labels stay a pure function of the canvas.
   */
  readonly resolveFileLabel?: (file: string) => string | undefined
  /**
   * Resolves a file node's reference to the referenced spatial canvas for
   * INLINE embedding. Absent, or `undefined` for a reference, keeps the
   * card-only rendering. Recursion is depth-capped (3) with path-local
   * cycle detection — a re-visit on the current path degrades to the card.
   */
  readonly resolveFileCanvas?: (file: string) => SpatialCanvas | undefined
  /**
   * The caller's expansion policy (the LOD gate): called per file node
   * when `resolveFileCanvas` is present; `false` (or an absent callback)
   * keeps the card. canvas-render itself has no expansion policy — the
   * editor decides by on-screen size, export by intrinsic size.
   */
  readonly expandFileNode?: (node: Extract<SpatialNode, { type: 'file' }>) => boolean
  /**
   * Resolves a file node's reference to a renderable IMAGE (href emitted
   * verbatim into the SVG — a data: URI in exports, a blob:/app URL in the
   * editor). Checked BEFORE the canvas-embed seam and not LOD-gated: a
   * scaled-down image is still a meaningful thumbnail, unlike crushed
   * canvas content. `undefined` (or a throw) keeps the card.
   */
  readonly resolveFileImage?: (
    file: string,
  ) => { readonly href: string; readonly alt?: string } | undefined
}

/** Internal: options with geometry resolved exactly once per layout call. */
interface ResolvedLayoutOptions extends SpatialLayoutOptions {
  /** File references on the CURRENT recursion path, plus its depth. */
  readonly embedPath: ReadonlySet<string>
  readonly embedDepth: number
  readonly geometry: SpatialGeometry
}

/**
 * Resolves the effective geometry for one `layoutSpatialCanvas` call.
 * A non-finite or out-of-range override degrades to the shared default
 * field-by-field, keeping this function total rather than letting a bad
 * override propagate NaN/negative values into node/text geometry.
 */
function nonNegativeOr(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

function positiveOr(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function resolveGeometry(geometry: SpatialGeometry | undefined): SpatialGeometry {
  if (!geometry) return SPATIAL_THEME_GEOMETRY
  return {
    paddingPx: nonNegativeOr(geometry.paddingPx, SPATIAL_THEME_GEOMETRY.paddingPx),
    labelFontSizePx: positiveOr(geometry.labelFontSizePx, SPATIAL_THEME_GEOMETRY.labelFontSizePx),
    minContentWidthPx: nonNegativeOr(
      geometry.minContentWidthPx,
      SPATIAL_THEME_GEOMETRY.minContentWidthPx,
    ),
  }
}

function contentWidth(nodeWidth: number, options: ResolvedLayoutOptions): number {
  const width = nodeWidth - 2 * options.geometry.paddingPx
  const floor = options.geometry.minContentWidthPx
  return Number.isFinite(width) && width > floor ? width : floor
}

function chromeShape(node: SpatialNode, options: ResolvedLayoutOptions): ShapeSceneNode {
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
function labelRun(text: string, options: ResolvedLayoutOptions): TextRunNode {
  const labelAppearance = options.appearance.resolveLabel()
  const font = {
    family: labelAppearance.fontFamily ?? 'sans-serif',
    fallbackChain: [],
    weight: 400,
    style: 'normal' as const,
    sizePx: options.geometry.labelFontSizePx,
  }
  const metrics = options.measure(text, font)
  // A TRUE top-left bbox with an explicit baseline — the earlier
  // baseline-smuggled-into-bbox.y convention made every geometric
  // computation over the box (outside-label placement, bounds) off by one
  // ascent while rendering identically.
  return {
    kind: 'textRun',
    bbox: {
      x: 0,
      y: 0,
      w: metrics.advanceWidth,
      h: metrics.ascent + metrics.descent,
    },
    baseline: metrics.ascent,
    text,
    appearance: { ...labelAppearance, fontSize: options.geometry.labelFontSizePx },
  }
}

/** Moves a node's content from its own origin to the node's padded top-left. */
function placeInNode(
  node: SpatialNode,
  content: Scene,
  options: ResolvedLayoutOptions,
): readonly SceneNode[] {
  const padding = options.geometry.paddingPx
  return translateScene(content, node.x + padding, node.y + padding).nodes
}

/** Gap between a container's outside label and its frame's top edge. */
const CONTAINER_LABEL_GAP_PX = 4

/**
 * Places a container's label OUTSIDE the frame, above its top-left corner
 * — the jsoncanvas.org convention. An outside label is what visually
 * distinguishes a container (group frame, expanded canvas embed) from a
 * regular node, whose label stays inside its card.
 */
function placeAboveNode(node: SpatialNode, content: Scene): readonly SceneNode[] {
  const bottom = Math.max(
    0,
    ...content.nodes.map((entry) => (entry.kind === 'edge' ? 0 : entry.bbox.y + entry.bbox.h)),
  )
  return translateScene(content, node.x, node.y - CONTAINER_LABEL_GAP_PX - bottom).nodes
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
  options: ResolvedLayoutOptions,
): readonly SceneNode[] {
  const maxWidth = contentWidth(node.width, options)
  let body: Scene
  try {
    const mdast = options.parseBody(node.text)
    body = layoutMdastBlocks(mdast, {
      measure: options.measure,
      maxWidth,
      // Body content is measured and declared with the SAME family the
      // label path resolves, so one theme drives every glyph in a node.
      fontFamily: options.appearance.resolveLabel().fontFamily ?? 'sans-serif',
    })
  } catch (err) {
    options.onDegrade?.({ kind: 'body-parse-failed', nodeId: node.id, err })
    body = { nodes: [labelRun(node.text, options)] }
  }
  return [chromeShape(node, options), ...placeInNode(node, body, options)]
}

/** The readable label of a non-text node, or `undefined` when it has none. */
function labelOf(
  node: Extract<SpatialNode, { type: 'file' | 'link' | 'group' }>,
  options: ResolvedLayoutOptions,
): string | undefined {
  switch (node.type) {
    case 'file': {
      let resolved: string | undefined
      try {
        resolved = options.resolveFileLabel?.(node.file)
      } catch {
        resolved = undefined
      }
      const base = resolved ?? node.file
      return node.subpath ? `${base}${node.subpath}` : base
    }
    case 'link':
      return node.url
    case 'group':
      return node.label && node.label.length > 0 ? node.label : undefined
  }
}

/** Depth cap matching embed-recursion.ts's contract: root is 0, the 4th level degrades. */
const FILE_EMBED_DEPTH_CAP = 3

/**
 * The inline-embedded rendering of a file node: the referenced canvas laid
 * out at native size, scaled to fit the node's content area (never
 * upscaled), and placed under the label band. Returns undefined whenever
 * the card should render instead — no resolver, policy says collapsed,
 * unresolvable reference, cycle on the current path, depth cap, or a
 * degenerate fit.
 */
function composeFileEmbed(
  node: Extract<SpatialNode, { type: 'file' }>,
  options: ResolvedLayoutOptions,
): SceneNode | undefined {
  const resolveFileCanvas = options.resolveFileCanvas
  if (resolveFileCanvas === undefined) return undefined
  if (options.expandFileNode?.(node) !== true) return undefined
  if (options.embedDepth >= FILE_EMBED_DEPTH_CAP || options.embedPath.has(node.file)) {
    return undefined
  }
  let child: SpatialCanvas | undefined
  try {
    child = resolveFileCanvas(node.file)
  } catch {
    child = undefined
  }
  if (child === undefined) return undefined

  const childScene = layoutSpatialCanvasInternal(child, {
    ...options,
    embedPath: new Set([...options.embedPath, node.file]),
    embedDepth: options.embedDepth + 1,
  })
  const bounds = sceneBounds(childScene)
  const padding = options.geometry.paddingPx
  // The reference label sits OUTSIDE the frame (see placeAboveNode), so
  // the miniature gets the whole padded box.
  const innerW = node.width - 2 * padding
  const innerH = node.height - 2 * padding
  const fit = Math.min(innerW / bounds.w, innerH / bounds.h, 1)
  if (!Number.isFinite(fit) || fit <= 0) return undefined

  const atOrigin = translateScene(childScene, -bounds.x, -bounds.y)
  const scaled = scaleScene(atOrigin, fit)
  const placed = translateScene(scaled, node.x + padding, node.y + padding)
  return {
    kind: 'embedResolved',
    bbox: { x: node.x, y: node.y, w: node.width, h: node.height },
    canvasId: node.file,
    children: placed.nodes,
  }
}

/** The image rendering of a file node: fills the padded box, aspect kept. */
function composeFileImage(
  node: Extract<SpatialNode, { type: 'file' }>,
  options: ResolvedLayoutOptions,
): SceneNode | undefined {
  if (options.resolveFileImage === undefined) return undefined
  let resolved: { readonly href: string; readonly alt?: string } | undefined
  try {
    resolved = options.resolveFileImage(node.file)
  } catch {
    resolved = undefined
  }
  if (resolved === undefined) return undefined
  const padding = options.geometry.paddingPx
  const w = node.width - 2 * padding
  const h = node.height - 2 * padding
  if (!(w > 0) || !(h > 0)) return undefined
  return {
    kind: 'image',
    bbox: { x: node.x + padding, y: node.y + padding, w, h },
    href: resolved.href,
    ...(resolved.alt !== undefined ? { alt: resolved.alt } : {}),
  }
}

/**
 * JSON Canvas group background: a full-frame image behind the members.
 * `backgroundStyle` maps 'ratio' -> contain and 'cover'/absent -> cover
 * (the spec's visual default); 'repeat' degrades to cover, reported via
 * `onDegrade`. Resolution failures keep the plain frame, matching the
 * file-image seam's never-throw rule.
 */
function composeGroupBackground(
  node: Extract<SpatialNode, { type: 'group' }>,
  options: ResolvedLayoutOptions,
): SceneNode | undefined {
  if (node.background === undefined || options.resolveFileImage === undefined) return undefined
  let resolved: { readonly href: string; readonly alt?: string } | undefined
  try {
    resolved = options.resolveFileImage(node.background)
  } catch {
    resolved = undefined
  }
  if (resolved === undefined) return undefined
  if (!(node.width > 0) || !(node.height > 0)) return undefined
  if (node.backgroundStyle === 'repeat') {
    options.onDegrade?.({ kind: 'unsupported-background-style', nodeId: node.id, style: 'repeat' })
  }
  return {
    kind: 'image',
    bbox: { x: node.x, y: node.y, w: node.width, h: node.height },
    href: resolved.href,
    ...(resolved.alt !== undefined ? { alt: resolved.alt } : {}),
    fit: node.backgroundStyle === 'ratio' ? 'contain' : 'cover',
  }
}

function composeNode(node: SpatialNode, options: ResolvedLayoutOptions): readonly SceneNode[] {
  switch (node.type) {
    case 'file': {
      const image = composeFileImage(node, options)
      if (image !== undefined) {
        // Full-bleed image, no label run — the filename would overlap the
        // picture; the accessible name travels on the image node itself.
        return [chromeShape(node, options), image]
      }
      const embed = composeFileEmbed(node, options)
      if (embed !== undefined) {
        const chrome = chromeShape(node, options)
        const label = labelOf(node, options)
        return label === undefined
          ? [chrome, embed]
          : [chrome, ...placeAboveNode(node, { nodes: [labelRun(label, options)] }), embed]
      }
      break
    }
    default:
      break
  }
  switch (node.type) {
    case 'text':
      return composeTextNode(node, options)
    case 'group': {
      const chrome = chromeShape(node, options)
      const background = composeGroupBackground(node, options)
      const base = background === undefined ? [chrome] : [chrome, background]
      const label = labelOf(node, options)
      return label === undefined
        ? base
        : [...base, ...placeAboveNode(node, { nodes: [labelRun(label, options)] })]
    }
    case 'file':
    case 'link': {
      const chrome = chromeShape(node, options)
      const label = labelOf(node, options)
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
  options: ResolvedLayoutOptions,
): ResolvedEdgeNode {
  // `routeEdge` already degrades a missing endpoint per canvas-render's own
  // documented contract — nothing further to catch here.
  //
  // The routing style rides on the canvas, which this function already has,
  // so honouring it costs no new plumbing through the consumers: editor,
  // export and viewer all pass the canvas and get the same routes from it.
  const routed = routeEdge(canvas.nodes, edge, canvas['x-whiteboard']?.edgeRouting?.style)
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
  options: ResolvedLayoutOptions,
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
    sizePx: options.geometry.labelFontSizePx,
  }
  const metrics = options.measure(edge.label, font)
  const width = metrics.advanceWidth
  const height = metrics.ascent + metrics.descent
  return {
    kind: 'textRun',
    bbox: { x: center.x - width / 2, y: center.y - height / 2, w: width, h: height },
    baseline: metrics.ascent,
    text: edge.label,
    appearance: { ...labelAppearance, fontSize: options.geometry.labelFontSizePx },
  }
}

/**
 * Composes a canvas-render `Scene` from a `SpatialCanvas`. Pure: takes the
 * already-read canvas plus injected measurer/body-parser/appearance, and
 * performs no I/O. Geometry is resolved exactly once here (see
 * `resolveGeometry`) and threaded to every helper as `ResolvedLayoutOptions`.
 */
export function layoutSpatialCanvas(canvas: SpatialCanvas, options: SpatialLayoutOptions): Scene {
  return layoutSpatialCanvasInternal(canvas, {
    ...options,
    geometry: resolveGeometry(options.geometry),
    embedPath: new Set(),
    embedDepth: 0,
  })
}

function layoutSpatialCanvasInternal(
  canvas: SpatialCanvas,
  resolved: ResolvedLayoutOptions,
): Scene {
  const nodeContent = canvas.nodes.flatMap((node) => composeNode(node, resolved))
  const edgeContent = canvas.edges.map((edge) => composeEdge(canvas, edge, resolved))
  const labelContent = canvas.edges
    .map((edge, index) => composeEdgeLabel(edge, edgeContent[index]!, resolved))
    .filter((label): label is TextRunNode => label !== undefined)
  return { nodes: [...nodeContent, ...edgeContent, ...labelContent] }
}
