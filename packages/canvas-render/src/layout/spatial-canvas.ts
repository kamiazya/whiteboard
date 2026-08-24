// Composes a canvas-render `Scene` from a `SpatialCanvas`. This is the
// single SpatialCanvas -> Scene builder shared by every consumer (Node
// export, the browser viewer) — see package-canvas-render.md's resolved
// decision. Process-internal (a value in, a value out), so per
// zod-schema-discipline no Zod schema is warranted.
//
// The markdown parser DEFAULTS to codec's `parseMarkdownBody` and stays
// overridable: every production caller passed that exact function, so the
// seam was seven identical lines, but layout tests parse with a stub for the
// same reason they measure with one. `appearance` is a genuinely injected
// `SpatialAppearanceResolver` (spatial-appearance.ts) — layout never chooses
// a color.
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

import { parseMarkdownBody } from '@kamiazya/whiteboard-codec'
import type {
  CanvasEdge,
  EdgeRoutingStyle,
  SpatialCanvas,
  SpatialNode,
} from '@kamiazya/whiteboard-model'
import type { MdastFlowContent, MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import {
  resolveCanvasEdgeStyle,
  resolveNodeShape,
  resolveNodeTextAlign,
  VISUAL_SHAPE_KEY,
} from '@kamiazya/whiteboard-plugin-visual'
import { visualDecorations } from '@kamiazya/whiteboard-plugin-visual/decorations'

/** The namespace `visual.shape/v0` composes its ids under. */
const VISUAL_NAMESPACE = VISUAL_SHAPE_KEY.slice(0, VISUAL_SHAPE_KEY.indexOf('.'))

import { highlightCode } from '../highlight/lowlight.js'
import type { MeasureText } from '../measure.js'
import { sceneBounds } from '../scene-bounds.js'
import type {
  Appearance,
  BoundingBox,
  ResolvedEdgeNode,
  Scene,
  SceneNode,
  ShapeSceneNode,
  TextRunNode,
} from '../scene-graph.js'
import { SPATIAL_THEME_GEOMETRY, type SpatialGeometry } from '../theme/spatial-geometry.js'
import { computeEdgeJumps } from './edges/edge-jumps.js'
import { edgeLabelAnchor } from './edges/edge-label-anchor.js'
import {
  assignEdgeAnchors,
  type EdgeAnchorOverride,
  type EdgeAnchorPair,
  routeEdge,
} from './edges/spatial-edges.js'
import {
  type FittedBlocks,
  firstLineOfBlocks,
  fitBlocksToHeight,
  layoutMdastBlocks,
  type MdastLayoutOptions,
} from './nodes/mdast-blocks.js'
import { outlineContentBox, outlineEntryPoint, type ShapeTable } from './nodes/node-outline.js'
import type { SpatialAppearanceResolver } from './nodes/spatial-appearance.js'
import { fitToWidth } from './nodes/truncate.js'
import { scaleScene } from './scale-scene.js'
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
  // never has (no image decoding behind the resolved `image`) — it
  // renders as 'cover' and the caller is told.
  | {
      readonly kind: 'unsupported-background-style'
      readonly nodeId: string
      readonly style: 'repeat'
    }

/**
 * Presentation-shaped card content for a file node, mapped by the caller
 * from its own facet data (model's `coreFacetsSchema` and friends).
 * Deliberately NOT domain-shaped: this package renders "one bare heading
 * line, then labelled rows" and learns nothing about what a facet MEANS —
 * the semantic mapping (`title = facets.title ?? facets.type`, one row per
 * core facet) is the caller's job. Plain TS, not Zod, per
 * zod-schema-discipline: it is constructed and consumed entirely
 * in-process and never crosses a process boundary.
 */
export interface FacetCardData {
  readonly title?: string
  readonly rows: readonly { readonly label: string; readonly value: string }[]
}

export interface SpatialLayoutOptions {
  readonly measure: MeasureText
  /**
   * How a `text` node's body becomes mdast. Defaults to codec's
   * `parseMarkdownBody`, which is what EVERY production caller passed —
   * seven identical lines whose only reason to exist was this package once
   * being forbidden to depend on codec. It stays injectable because layout
   * tests deliberately parse with a stub, the same way they measure with
   * one: a layout assertion should not fail because a markdown parser
   * changed.
   */
  readonly parseBody?: (text: string) => MdastRoot
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
  /**
   * Frozen edge-side choices, threaded to `assignEdgeAnchors`: the caller
   * trades crossing optimization for route stability (the live drag
   * overlay pins the committed sides so routes do not flip mid-gesture and
   * pointer frames skip the improvement loop). Absent means sides settle
   * through the full pipeline.
   */
  readonly edgeSideOverrides?: ReadonlyMap<string, EdgeAnchorOverride>
  /**
   * Non-rect silhouettes per node id, threaded onto each node's chrome
   * shape and consulted when finishing edge routes (a terminal on the
   * bbox border is pulled onto the outline rim via `outlineEntryPoint`).
   * Plain DATA — a record, never a resolver function — for the same
   * reason as `ResolvedReference`: it must cross `postMessage` so worker
   * layout keeps working when outlines are wired.
   */
  readonly nodeOutlines?: Readonly<Record<string, string>>
  /**
   * Silhouettes by namespaced id, merged OVER the built-in table — the same
   * shape as `SvgDocumentOptions.icons`. The backend must be handed the same
   * table, or a contributed shape lays out correctly and paints as a rect.
   */
  readonly shapes?: ShapeTable
  /**
   * Facet keys, besides the bundled `visual.shape/v0`, that declare a node's
   * shape. Each key's namespace plus its payload's `kind` composes the id.
   */
  readonly shapeFacets?: readonly string[]
  /**
   * What plugins draw ON a node, after its own content. Defaults to the
   * bundled `visual` plugin's — a DEFAULT rather than an opt-in, for the
   * lowlight reason: a resolution step four call sites have to remember is
   * a step one of them forgets, and the surface that forgets does not fall
   * back to the same picture, it silently draws less.
   *
   * Decorations COMPOSE, so several contributions on one node stack in
   * contribution order rather than competing. That is why this needs no
   * conflict rule, unlike a silhouette.
   */
  readonly decorations?: readonly NodeDecoration[]
  readonly onDegrade?: (event: SpatialLayoutDegradation) => void
  /**
   * The mdast CONTENT seams, forwarded verbatim to every `layoutMdastBlocks`
   * call this module makes — a spatial `text` node's body, and a file node's
   * referenced markdown body.
   *
   * Declared here as a passthrough rather than re-specified, because a body
   * is a body: the same document laid out in the markdown editor and inside
   * a canvas node must resolve its math, diagram fences and `![[embed]]`s
   * the same way. Leaving them unforwarded is what made one engine give two
   * answers depending on which surface called it.
   *
   * Absent seams keep `layoutMdastBlocks`'s own documented fallbacks (the
   * escaped-source math placeholder, a plain code block, an
   * `embedPlaceholder`), so an export or viewer that wires none renders
   * exactly as before.
   */
  readonly renderMath?: MdastLayoutOptions['renderMath']
  readonly renderDiagram?: MdastLayoutOptions['renderDiagram']
  readonly resolveEmbed?: MdastLayoutOptions['resolveEmbed']
  /**
   * Tokeniser for fenced code. Defaults to this package's own lowlight-backed
   * implementation, for the same reason `parseBody` defaults to codec's
   * parser: every surface that lays a markdown body out wants it, and the one
   * that forgets it does not fall back to the same picture — it renders code
   * plain while the others colour it.
   *
   * That is not hypothetical. It shipped wired at ONE of the four call sites
   * and left export — the surface the change was for — drawing every fence
   * plain. Supplying it was made an opt-in step, and an opt-in step in four
   * places is a step that gets missed.
   *
   * Still an option, so a caller can substitute a different tokeniser or pass
   * a no-op to render plain. What changed is which way round the default
   * points.
   */
  readonly highlightCode?: MdastLayoutOptions['highlightCode']
  /**
   * Resolves one reference — a file node's `file`, or a group's
   * `background` — to everything the caller knows about it. Absent, or
   * `undefined` for a reference, keeps the plain chrome+label rendering;
   * a throw is caught (total-layout rule) and read as `undefined`.
   *
   * ONE seam rather than one per content kind, because a caller has ONE
   * document per reference: the six callbacks this replaced were six
   * closures over the same lookup, called four times per node for the same
   * key, and every consumer that wired any of them wired most. Collapsing
   * them also makes a resolution plain DATA, which a function seam could
   * never be — the layout worker refuses any canvas whose file seams are
   * wired precisely because a function cannot cross `postMessage`.
   *
   * `expandFileNode` stays separate: it is the caller's POLICY over a node
   * (the editor decides by on-screen size, export by intrinsic size), not
   * something known about the reference. `MdastLayoutOptions.resolveEmbed`
   * likewise stays its own seam — it is keyed by a documentId appearing in
   * prose, not by a spatial node's reference.
   */
  readonly resolveReference?: (ref: string) => ResolvedReference | undefined
  /**
   * The caller's expansion policy (the LOD gate): called per file node
   * when a resolution carries a `canvas`; `false` (or an absent callback)
   * keeps the card. canvas-render itself has no expansion policy — the
   * editor decides by on-screen size, export by intrinsic size.
   */
  readonly expandFileNode?: (node: Extract<SpatialNode, { type: 'file' }>) => boolean
  /**
   * Optional memo for a text node's laid-out body. Content is laid out in
   * ORIGIN-RELATIVE coordinates and placed by `placeInNode`, so a cached
   * value is position-independent by construction: keyed by the node's
   * text and box size only. Everything else that shapes content —
   * `measure`, the appearance resolver, `geometry`, `parseBody`, the mdast
   * seams — is deliberately NOT in the key: the CALLER owns the cache's
   * lifetime and must discard it when any of those change (in practice:
   * one cache per document+theme, dropped on theme/font switches). Cached
   * values are shared between scenes and must be treated as immutable,
   * which scene nodes already are.
   *
   * Only the success path is cached. The parse-failure fallback recomputes
   * every run so `onDegrade` keeps firing — a cache must change timings,
   * never what the caller is told.
   *
   * Measured before building (the instrument-first rule): content layout
   * is 15-18ms of a 66-125ms full layout on the scene-diff corpus with the
   * arithmetic test measurer — edge routing dominates — so this memo buys
   * roughly the content share, more under a real (Canvas/opentype)
   * measurer whose per-call cost is far above the fake's.
   */
  readonly contentCache?: SpatialContentCache
}

/**
 * The store behind `SpatialLayoutOptions.contentCache`. Deliberately a
 * plain get/set pair rather than a Map subtype, so a caller can wrap an
 * LRU, a WeakRef map, or a plain object without this package caring.
 */
export interface SpatialContentCache {
  get(key: string): FittedBlocks | undefined
  set(key: string, value: FittedBlocks): void
}

/**
 * What a caller knows about one reference. Every field is optional and
 * independent — a caller supplies what it has, and the ranking below
 * decides what gets painted.
 *
 * The content fields are ranked, highest first: `image` (a scaled-down
 * picture is still a meaningful thumbnail, so it is not LOD-gated),
 * `canvas` (inline-embedded, depth-capped at 3 with path-local cycle
 * detection, and gated by `expandFileNode`), `markdown` (the document's own
 * prose, which says more about it than the facets describing it), then
 * `facets`. Anything that produces no usable content — an empty body, a
 * card with no title or rows, a box too small for one block — falls through
 * to the next rank and finally to the plain chrome+label rendering.
 */
export interface ResolvedReference {
  /**
   * Human-readable name, for a caller whose references are opaque ids (the
   * browser-local store). Absent falls back to the raw reference string,
   * which is why an export that resolves nothing keeps labels a pure
   * function of the canvas.
   *
   * A document's name lives in the workspace, not in its content
   * (vocabulary.md) — which is why the markdown body below carries no title
   * of its own, unlike `MdastLayoutOptions.resolveEmbed`, whose embed mixed
   * into prose has no other name source.
   */
  readonly label?: string
  /**
   * The reference points at a target that no longer exists (deleted
   * document, an imported ref into a store that never had it). Renders a
   * quiet "Missing reference" label instead of the raw reference, which for
   * an opaque id tells a reader nothing. This package only paints the
   * state; deciding it is a lookup against the live document list, and so
   * the caller's.
   */
  readonly missing?: boolean
  /** A renderable image: `href` is emitted verbatim into the SVG — a data: URI in exports, a blob:/app URL in the editor. */
  readonly image?: { readonly href: string; readonly alt?: string }
  /** The referenced spatial canvas, for inline embedding. */
  readonly canvas?: SpatialCanvas
  /** A referenced markdown document's already-parsed body. */
  readonly markdown?: MdastRoot
  /** Card content built from the referenced document's facet data. */
  readonly facets?: FacetCardData
}

/** Internal: options with geometry resolved exactly once per layout call. */
interface ResolvedLayoutOptions extends SpatialLayoutOptions {
  /** File references on the CURRENT recursion path, plus its depth. */
  readonly embedPath: ReadonlySet<string>
  readonly embedDepth: number
  readonly geometry: SpatialGeometry
  readonly parseBody: (text: string) => MdastRoot
  /**
   * Whether content is trimmed to the node's box. INTERNAL — deliberately
   * not on `SpatialLayoutOptions`, so a normal render can never turn the
   * fit off by accident. `naturalNodeContentSize` is the one caller that
   * clears it, and it is a named function precisely so the intent is
   * legible at the call site instead of being inferred from a degenerate
   * height.
   */
  readonly fitToBox: boolean
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

/**
 * The `MdastLayoutOptions` every body layout in this module is built from —
 * one producer, so a seam added to `SpatialLayoutOptions` cannot reach a
 * text node's body and silently miss a file node's, which is exactly how
 * the fragment seams came to be wired on one surface only.
 */
function mdastOptionsFor(maxWidth: number, options: ResolvedLayoutOptions): MdastLayoutOptions {
  return {
    measure: options.measure,
    maxWidth,
    // Body content is measured and declared with the SAME family the label
    // path resolves, so one theme drives every glyph in a node — and painted
    // with the SAME fill, for the same reason. `resolveLabel` is already the
    // seam for "a degraded body fallback run"; a body that renders owes its
    // colour to the same producer as one that does not.
    fontFamily: options.appearance.resolveLabel().fontFamily ?? 'sans-serif',
    ...(options.appearance.resolveLabel().fill !== undefined
      ? { textFill: options.appearance.resolveLabel().fill }
      : {}),
    ...(options.appearance.resolveSyntax !== undefined
      ? { syntax: options.appearance.resolveSyntax() }
      : {}),
    ...(options.highlightCode !== undefined ? { highlightCode: options.highlightCode } : {}),
    ...(options.renderMath !== undefined ? { renderMath: options.renderMath } : {}),
    ...(options.renderDiagram !== undefined ? { renderDiagram: options.renderDiagram } : {}),
    ...(options.resolveEmbed !== undefined ? { resolveEmbed: options.resolveEmbed } : {}),
  }
}

/**
 * The box a node's content lays out against: the silhouette's inscribed box
 * for a shaped node, the node box itself otherwise. Natural sizing
 * (`fitToBox: false`) stays rect-based — it asks how big the BOX must be,
 * and the inscribed mapping would have to be inverted, not applied.
 * ponytail: auto-fit under-sizes a shaped node; invert outlineContentBox in
 * naturalNodeContentSize when shaped auto-fit matters.
 *
 * The placement policy (inscribed box + vertical centering below) is fixed
 * today; a later visual text-placement facet resolves per node HERE, the
 * same seam `resolveNodeOutlines` fills for the silhouette itself.
 */
function nodeContentBounds(node: SpatialNode, options: ResolvedLayoutOptions): BoundingBox {
  const box = { x: node.x, y: node.y, w: node.width, h: node.height }
  if (!options.fitToBox) return box
  return outlineContentBox(options.nodeOutlines?.[node.id], box, options.shapes)
}

function contentWidth(node: SpatialNode, options: ResolvedLayoutOptions): number {
  const width = nodeContentBounds(node, options).w - 2 * options.geometry.paddingPx
  const floor = options.geometry.minContentWidthPx
  return Number.isFinite(width) && width > floor ? width : floor
}

function chromeShape(node: SpatialNode, options: ResolvedLayoutOptions): ShapeSceneNode {
  const resolved = options.appearance.resolveNode(node)
  const shape = options.nodeOutlines?.[node.id]
  return {
    kind: 'shape',
    id: node.id,
    bbox: { x: node.x, y: node.y, w: node.width, h: node.height },
    ...(resolved.radius !== undefined ? { radius: resolved.radius } : {}),
    ...(shape !== undefined ? { shape } : {}),
    ...(resolved.appearance !== undefined ? { appearance: resolved.appearance } : {}),
  }
}

/**
 * A label run in CONTENT-ORIGIN-RELATIVE coordinates, matching what
 * `layoutMdastBlocks` produces. Placement is always the caller's job, via
 * `placeInNode`. An absolute-coordinate variant here would be applied
 * twice wherever its output also flows through the translation step.
 */
function labelRun(text: string, options: ResolvedLayoutOptions, maxWidth: number): TextRunNode {
  const labelAppearance = options.appearance.resolveLabel()
  const font = {
    family: labelAppearance.fontFamily ?? 'sans-serif',
    fallbackChain: [],
    weight: 400,
    style: 'normal' as const,
    sizePx: options.geometry.labelFontSizePx,
  }
  // A label never wraps — one line is what makes it a label — so the only way
  // to keep it inside the box is to cut it, and `truncated` is what the SVG
  // backend fades.
  const fitted = fitToWidth(text, font, options.measure, maxWidth)
  const metrics = options.measure(fitted.text, font)
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
    text: fitted.text,
    ...(fitted.truncated ? { truncated: true as const } : {}),
    appearance: { ...labelAppearance, fontSize: options.geometry.labelFontSizePx },
  }
}

/** Moves a node's content from its own origin to the node's padded top-left. */
/**
 * The node's chrome, carrying whether its content had to be cut to fit.
 *
 * The same fact the fade marks on the last surviving run, put where a READER
 * of the scene can find it: `sceneDigest` reports per addressable node, and a
 * node's content is a SIBLING of its chrome in the flat scene list, so a
 * digest could never correlate the two on its own. A fade is for a human
 * looking at pixels; an agent reads the digest and otherwise learns nothing.
 */
function chromeWithFit(
  node: SpatialNode,
  options: ResolvedLayoutOptions,
  truncated: boolean,
): ShapeSceneNode {
  const chrome = chromeShape(node, options)
  return truncated ? { ...chrome, truncated: true } : chrome
}

function placeInNode(
  node: SpatialNode,
  content: Scene,
  options: ResolvedLayoutOptions,
): readonly SceneNode[] {
  const padding = options.geometry.paddingPx
  const bounds = nodeContentBounds(node, options)
  // A SHAPED node centers content that fits vertically — the diagram-symbol
  // convention (Excalidraw/draw.io). An overflowing body fills the inscribed
  // box, so the offset is 0 and the top-aligned truncate+fade contract is
  // untouched; a plain rect never gets an offset, keeping every existing
  // canvas byte-identical.
  //
  // `visual.text/v0` OVERRIDES that default in either direction: a rect may
  // ask to centre, a shaped node to start at the top. Absent, the default
  // above is what happens — which is why the facet has no third value.
  const align = resolveNodeTextAlign(node)
  const centres =
    align === undefined ? options.nodeOutlines?.[node.id] !== undefined : align === 'center'
  let dy = 0
  if (options.fitToBox && centres) {
    const innerH = bounds.h - 2 * padding
    const contentH = Math.max(
      0,
      ...content.nodes.map((entry) => (entry.kind === 'edge' ? 0 : entry.bbox.y + entry.bbox.h)),
    )
    if (contentH < innerH) dy = (innerH - contentH) / 2
  }
  return translateScene(content, bounds.x + padding, bounds.y + padding + dy).nodes
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
/**
 * The text node's own fit: the blocks that fit, but never fewer than one.
 *
 * A text node has no lower-ranked rendering to degrade to, so dropping
 * everything erases the user's own prose — and the box that keeps nothing is
 * not the pathological one, it is a node one line tall: at the default
 * padding a 25px-high node leaves 9px of content box for a ~16px line. That
 * is the same reasoning as `fitToWidth` never returning the empty string,
 * applied to the other axis. The block that stays squeezes the padding rather
 * than leaving the FRAME, which is the bound this whole fit exists to keep.
 *
 * The sibling seams keep `fitSceneInNode`'s `undefined` because they DO have
 * somewhere better to go — the plain chrome-and-label rendering.
 */
function fitTextBody(
  scene: Scene,
  node: SpatialNode,
  options: ResolvedLayoutOptions,
): FittedBlocks {
  // Keep-first's unit is a LINE, not a block: see `firstLineOfBlocks`.
  return fitSceneInNode(scene, node, options) ?? firstLineOfBlocks(scene.nodes)
}

function composeTextNode(
  node: Extract<SpatialNode, { type: 'text' }>,
  options: ResolvedLayoutOptions,
): readonly SceneNode[] {
  const maxWidth = contentWidth(node, options)
  // Position deliberately absent from the key: the cached value is
  // origin-relative (see `contentCache`'s contract), so a moved node hits.
  // The silhouette is part of the key: a shaped node lays out against its
  // inscribed box, so the same (width, height, text) fits differently.
  const cacheKey =
    options.contentCache === undefined
      ? undefined
      : JSON.stringify([
          node.width,
          node.height,
          node.text,
          options.nodeOutlines?.[node.id] ?? null,
        ])
  const cached = cacheKey === undefined ? undefined : options.contentCache?.get(cacheKey)
  let body: FittedBlocks
  if (cached !== undefined) {
    body = cached
  } else {
    try {
      const laid = layoutMdastBlocks(
        options.parseBody(node.text),
        mdastOptionsFor(maxWidth, options),
      )
      body = fitTextBody(laid, node, options)
      if (cacheKey !== undefined) options.contentCache?.set(cacheKey, body)
    } catch (err) {
      options.onDegrade?.({ kind: 'body-parse-failed', nodeId: node.id, err })
      body = fitTextBody({ nodes: [labelRun(node.text, options, maxWidth)] }, node, options)
    }
  }
  return [
    chromeWithFit(node, options, body.truncated),
    ...placeInNode(node, { nodes: body.nodes }, options),
  ]
}

/**
 * The caller's resolution for one reference, guarded to the never-throw
 * rule. The single place `resolveReference` is called, so every caller
 * below gets the same total behaviour without repeating a try/catch.
 */
function referenceFor(ref: string, options: ResolvedLayoutOptions): ResolvedReference | undefined {
  if (options.resolveReference === undefined) return undefined
  try {
    return options.resolveReference(ref)
  } catch {
    return undefined
  }
}

/** The readable label of a non-text node, or `undefined` when it has none. */
function labelOf(
  node: Extract<SpatialNode, { type: 'file' | 'link' | 'group' }>,
  resolved: ResolvedReference | undefined,
): string | undefined {
  switch (node.type) {
    case 'file': {
      // The raw reference is an opaque id — useless to a reader — and the
      // subpath is moot without a target, so neither appears.
      if (resolved?.missing === true) return 'Missing reference'
      const base = resolved?.label ?? node.file
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
  resolved: ResolvedReference | undefined,
  options: ResolvedLayoutOptions,
): SceneNode | undefined {
  const child = resolved?.canvas
  if (child === undefined) return undefined
  if (options.expandFileNode?.(node) !== true) return undefined
  if (options.embedDepth >= FILE_EMBED_DEPTH_CAP || options.embedPath.has(node.file)) {
    return undefined
  }

  const childScene = layoutSpatialCanvasInternalScene(child, {
    ...options,
    // Silhouettes resolve per CANVAS, keyed by that canvas's own node ids:
    // spreading the parent's map both drops the child's facets and leaks a
    // same-id root node's shape into the embedded canvas. Explicit per-node
    // overrides are root-keyed by contract, so they do not descend.
    nodeOutlines: resolveNodeOutlines(child, undefined, options.shapeFacets),
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
    documentId: node.file,
    children: placed.nodes,
  }
}

/** The image rendering of a file node: fills the padded box, aspect kept. */
function composeFileImage(
  node: Extract<SpatialNode, { type: 'file' }>,
  resolved: ResolvedReference | undefined,
  options: ResolvedLayoutOptions,
): SceneNode | undefined {
  const image = resolved?.image
  if (image === undefined) return undefined
  const padding = options.geometry.paddingPx
  const w = node.width - 2 * padding
  const h = node.height - 2 * padding
  if (!(w > 0) || !(h > 0)) return undefined
  return {
    kind: 'image',
    bbox: { x: node.x + padding, y: node.y + padding, w, h },
    href: image.href,
    ...(image.alt !== undefined ? { alt: image.alt } : {}),
  }
}

/**
 * Lays an mdast root out at a node's content width and keeps the blocks
 * that fit its padded content box. `undefined` for a degenerate box or
 * when not even the first block fits, so every caller degrades to its own
 * lower-ranked rendering instead of painting a clipped fragment.
 *
 * Shared by the facet-card and markdown-body seams rather than duplicated:
 * both put mdast blocks in a node box, and two producers of the same
 * geometry is the drift class package-canvas-render.md's "one producer per
 * geometry" rule exists to prevent.
 *
 * Truncation is at whole-block granularity: `layoutMdastBlocks` lays top-
 * level blocks out with strictly increasing bottoms, so the blocks whose
 * bottom fits are exactly a contiguous top prefix.
 *
 * ponytail: silently dropping the rest is the ceiling here — a "more"
 * affordance needs a focusable DOM-overlay/keyboard treatment this
 * pure-geometry package cannot own. Upgrade path is an editor-side overlay,
 * not a scene node here.
 */
function contentBox(
  node: SpatialNode,
  options: ResolvedLayoutOptions,
): { readonly w: number; readonly h: number } | undefined {
  const padding = options.geometry.paddingPx
  const bounds = nodeContentBounds(node, options)
  const w = bounds.w - 2 * padding
  const h = bounds.h - 2 * padding
  return w > 0 && h > 0 ? { w, h } : undefined
}

/**
 * Keeps the top prefix of an already-laid-out scene that fits a node's
 * padded content box, in content-relative coordinates.
 *
 * The single place the box's HEIGHT is enforced, so every seam that puts
 * content in a node box answers to the same bound — the "one producer per
 * geometry" rule. A seam that lays content out and places it without
 * passing through here paints outside the frame, which is a rendering
 * defect this package's "what cannot fit is cut" contract forbids.
 */
function fitSceneInNode(
  scene: Scene,
  node: SpatialNode,
  options: ResolvedLayoutOptions,
): FittedBlocks | undefined {
  if (!options.fitToBox) return { nodes: scene.nodes, truncated: false }
  const box = contentBox(node, options)
  if (box === undefined) return undefined
  const fitted = fitBlocksToHeight(scene.nodes, box.h)
  return fitted.nodes.length === 0 ? undefined : fitted
}

function fitBodyInNode(
  node: SpatialNode,
  root: MdastRoot,
  options: ResolvedLayoutOptions,
): FittedBlocks | undefined {
  // The degenerate-box guard is part of FITTING, not of laying out: under
  // `naturalNodeContentSize` there is no box to be degenerate against, and
  // returning `undefined` here made a file node fall back to its label, so
  // the one function whose whole contract is "independent of the stored
  // box" reported the label's height for a small box and the body's for a
  // large one.
  if (options.fitToBox && contentBox(node, options) === undefined) return undefined
  const body = layoutMdastBlocks(root, mdastOptionsFor(contentWidth(node, options), options))
  return fitSceneInNode(body, node, options)
}

/**
 * The markdown-body rendering of a file node: the referenced document's
 * own prose laid out inline in the node's content area, with the reference
 * label placed OUTSIDE the frame exactly as `composeFileEmbed` does — both
 * seams turn the node into a container showing another document, so they
 * must read the same way.
 *
 * Returns `undefined` — falling through to the facet card, then the plain
 * label — for every "nothing to show" path: no resolver, an `undefined` or
 * thrown result, an empty body, or a box too small for even one block.
 * Like every other file seam this is the expected common case rather than
 * an error, so it is never reported via `onDegrade`.
 */
function composeFileMarkdown(
  node: Extract<SpatialNode, { type: 'file' }>,
  resolved: ResolvedReference | undefined,
  options: ResolvedLayoutOptions,
): readonly SceneNode[] | undefined {
  const root = resolved?.markdown
  if (root === undefined) return undefined

  // The LAYOUT is guarded too, not just the resolver call. This seam is the
  // first to feed caller-supplied mdast straight into `layoutMdastBlocks`:
  // `composeTextNode` parses its own via `parseBody` (and catches), and
  // `composeFileFacets` builds its blocks internally, so both were total by
  // construction. `layoutBlock`'s switch has no default case and dereferences
  // per-kind fields, so a child the caller's own validation let through — a
  // null, a primitive, an unrecognised `type` — throws from here and, with no
  // per-node guard in the composition loop, takes the WHOLE canvas with it.
  // That would break this package's documented never-throw rule
  // (package-canvas-render.md) at the one seam that made it reachable.
  let body: FittedBlocks | undefined
  try {
    body = fitBodyInNode(node, root, options)
  } catch (err) {
    options.onDegrade?.({ kind: 'body-parse-failed', nodeId: node.id, err })
    return undefined
  }
  if (body === undefined) return undefined

  const chrome = chromeWithFit(node, options, body.truncated)
  const label = labelOf(node, resolved)
  const placed = placeInNode(node, { nodes: body.nodes }, options)
  return label === undefined
    ? [chrome, ...placed]
    : [
        chrome,
        ...placeAboveNode(node, { nodes: [labelRun(label, options, node.width)] }),
        ...placed,
      ]
}

/**
 * The facet-card rendering of a file node: a bare heading line (the card's
 * `title`) followed by one paragraph per row (`label: value`), laid out
 * through `layoutMdastBlocks` — the same producer `composeTextNode` uses —
 * rather than a second text-layout producer (package-canvas-render.md's
 * "one producer per geometry" rule). Deliberately only `heading`/
 * `paragraph` blocks: `list`/`table` are the only two block renderers that
 * emit their own SVG `transform` (the `subtreeOffsetX` class), and this
 * card has no reason to enter that tripwire.
 *
 * Returns `undefined` — keeping the plain chrome+label rendering — for
 * every "no usable content" path: no resolver, an `undefined` or thrown
 * result, a title that is empty/whitespace-only with no usable row, or a
 * degenerate (non-positive) content box. This is the expected common case,
 * not an error: the model guarantees payloads this layer cannot validate,
 * so canvas-render never reports it via `onDegrade`.
 */
function composeFileFacets(
  node: Extract<SpatialNode, { type: 'file' }>,
  resolved: ResolvedReference | undefined,
  options: ResolvedLayoutOptions,
): readonly SceneNode[] | undefined {
  const card = resolved?.facets
  if (card === undefined) return undefined

  const title = card.title?.trim() ? card.title : undefined
  const rows = card.rows.filter((row) => row.label.trim().length > 0 || row.value.trim().length > 0)
  if (title === undefined && rows.length === 0) return undefined

  const blocks: MdastFlowContent[] = []
  if (title !== undefined) {
    blocks.push({ type: 'heading', depth: 3, children: [{ type: 'text', value: title }] })
  }
  for (const row of rows) {
    blocks.push({
      type: 'paragraph',
      children: [
        { type: 'strong', children: [{ type: 'text', value: row.label }] },
        { type: 'text', value: `: ${row.value}` },
      ],
    })
  }

  const body = fitBodyInNode(node, { type: 'root', children: blocks }, options)
  if (body === undefined) return undefined

  return [
    chromeWithFit(node, options, body.truncated),
    ...placeInNode(node, { nodes: body.nodes }, options),
  ]
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
  if (node.background === undefined) return undefined
  const image = referenceFor(node.background, options)?.image
  if (image === undefined) return undefined
  if (!(node.width > 0) || !(node.height > 0)) return undefined
  if (node.backgroundStyle === 'repeat') {
    options.onDegrade?.({ kind: 'unsupported-background-style', nodeId: node.id, style: 'repeat' })
  }
  return {
    kind: 'image',
    bbox: { x: node.x, y: node.y, w: node.width, h: node.height },
    href: image.href,
    ...(image.alt !== undefined ? { alt: image.alt } : {}),
    fit: node.backgroundStyle === 'ratio' ? 'contain' : 'cover',
  }
}

function composeNode(node: SpatialNode, options: ResolvedLayoutOptions): readonly SceneNode[] {
  switch (node.type) {
    case 'file': {
      // Resolved ONCE per node and threaded through every rank below. The
      // seams this replaced re-asked for the same key at each rank, which
      // meant a caller's lookup ran four times per file node.
      const resolved = referenceFor(node.file, options)
      const image = composeFileImage(node, resolved, options)
      if (image !== undefined) {
        // Full-bleed image, no label run — the filename would overlap the
        // picture; the accessible name travels on the image node itself.
        return [chromeShape(node, options), image]
      }
      const embed = composeFileEmbed(node, resolved, options)
      if (embed !== undefined) {
        const chrome = chromeShape(node, options)
        const label = labelOf(node, resolved)
        return label === undefined
          ? [chrome, embed]
          : [
              chrome,
              ...placeAboveNode(node, { nodes: [labelRun(label, options, node.width)] }),
              embed,
            ]
      }
      const markdown = composeFileMarkdown(node, resolved, options)
      if (markdown !== undefined) return markdown
      const facets = composeFileFacets(node, resolved, options)
      if (facets !== undefined) return facets
      const chrome = chromeShape(node, options)
      const label = labelOf(node, resolved)
      return label === undefined
        ? [chrome]
        : [
            chrome,
            ...placeInNode(
              node,
              { nodes: [labelRun(label, options, contentWidth(node, options))] },
              options,
            ),
          ]
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
      const label = labelOf(node, undefined)
      return label === undefined
        ? base
        : [...base, ...placeAboveNode(node, { nodes: [labelRun(label, options, node.width)] })]
    }
    case 'link': {
      const chrome = chromeShape(node, options)
      const label = labelOf(node, undefined)
      return label === undefined
        ? [chrome]
        : [
            chrome,
            ...placeInNode(
              node,
              { nodes: [labelRun(label, options, contentWidth(node, options))] },
              options,
            ),
          ]
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
  routingStyle: EdgeRoutingStyle | undefined,
  anchors: EdgeAnchorPair | undefined,
): ResolvedEdgeNode {
  // `routeEdge` already degrades a missing endpoint per canvas-render's own
  // documented contract — nothing further to catch here.
  //
  // The routing style rides on the canvas, which this function already has,
  // so honouring it costs no new plumbing through the consumers: editor,
  // export and viewer all pass the canvas and get the same routes from it.
  const routed = pullEdgeOntoOutlines(
    routeEdge(canvas.nodes, edge, routingStyle, anchors),
    canvas,
    edge,
    options.nodeOutlines,
    options.shapes,
  )
  const appearance = options.appearance.resolveEdge(edge)
  return appearance === undefined ? routed : { ...routed, appearance }
}

/**
 * A route terminates ON the endpoint's bbox border, which for every
 * inscribed outline is OUTSIDE the silhouette except at tangent points —
 * an arrowhead would float off an ellipse's shoulder. Each end whose node
 * declares an outline is pulled inward along its own approach segment via
 * `outlineEntryPoint`, AFTER routing: the router and its cost model keep
 * reading rects, so routing behaviour (and the routing scoreboard) is
 * untouched by construction.
 */
function pullEdgeOntoOutlines(
  routed: ResolvedEdgeNode,
  canvas: SpatialCanvas,
  edge: CanvasEdge,
  nodeOutlines: Readonly<Record<string, string>> | undefined,
  shapes: ShapeTable | undefined,
): ResolvedEdgeNode {
  if (nodeOutlines === undefined || routed.path.length < 2) return routed
  const boxOf = (id: string): BoundingBox | undefined => {
    const node = canvas.nodes.find((candidate) => candidate.id === id)
    return node === undefined ? undefined : { x: node.x, y: node.y, w: node.width, h: node.height }
  }
  let path = routed.path
  // Compare coordinates, not object identity: relying on outlineEntryPoint
  // returning the very same object on its no-op paths is an unstated
  // contract, and a fresh-but-equal point must not rewrite the path (the
  // scene-diff scoreboard pins that untouched edges stay byte-identical).
  const moved = (
    a: { readonly x: number; readonly y: number },
    b: { readonly x: number; readonly y: number },
  ): boolean => a.x !== b.x || a.y !== b.y
  const toKind = nodeOutlines[edge.toNode]
  const toBox = toKind === undefined ? undefined : boxOf(edge.toNode)
  if (toKind !== undefined && toBox !== undefined) {
    const last = path[path.length - 1]
    const inward = path[path.length - 2]
    if (last !== undefined && inward !== undefined) {
      const pulled = outlineEntryPoint(toKind, toBox, inward, last, shapes)
      if (moved(pulled, last)) path = [...path.slice(0, -1), pulled]
    }
  }
  const fromKind = nodeOutlines[edge.fromNode]
  const fromBox = fromKind === undefined ? undefined : boxOf(edge.fromNode)
  if (fromKind !== undefined && fromBox !== undefined) {
    const first = path[0]
    const inward = path[1]
    if (first !== undefined && inward !== undefined) {
      const pulled = outlineEntryPoint(fromKind, fromBox, inward, first, shapes)
      if (moved(pulled, first)) path = [pulled, ...path.slice(1)]
    }
  }
  return path === routed.path ? routed : { ...routed, path }
}

/**
 * Composes a centered label run for an edge that carries one. Returns
 * `undefined` for no label, an empty/whitespace-only label, or a
 * degenerate path — `layoutSpatialCanvas` stays total either way. The
 * anchor comes from `edgeLabelAnchor`, the same producer the editor's
 * inline label editor uses.
 */
function composeEdgeLabel(
  edge: CanvasEdge,
  routed: ResolvedEdgeNode,
  options: ResolvedLayoutOptions,
): TextRunNode | undefined {
  if (edge.label === undefined || edge.label.trim().length === 0) return undefined
  const center = edgeLabelAnchor(routed.path, routed.rounded === true)
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
  return layoutSpatialCanvasWithAnchors(canvas, options).scene
}

/**
 * `layoutSpatialCanvas` plus the edge-anchor map the layout itself routed
 * with. The anchor pass is the most expensive step of the whole layout, and
 * the editor's drag start needs exactly the committed anchors — so a caller
 * holding the scene must never have to re-run the pass to get them. Same
 * one-producer rule as `layoutSpatialEdges`: this IS the layout, not a
 * second computation beside it.
 */
export function layoutSpatialCanvasWithAnchors(
  canvas: SpatialCanvas,
  options: SpatialLayoutOptions,
): { scene: Scene; anchors: ReadonlyMap<string, EdgeAnchorPair> } {
  return layoutSpatialCanvasInternal(canvas, {
    ...options,
    geometry: resolveGeometry(options.geometry),
    parseBody: options.parseBody ?? parseMarkdownBody,
    highlightCode: options.highlightCode ?? highlightCode,
    nodeOutlines: resolveNodeOutlines(canvas, options.nodeOutlines, options.shapeFacets),
    embedPath: new Set(),
    embedDepth: 0,
    fitToBox: true,
  })
}

/**
 * The extent a node's content occupies when NOTHING is trimmed to fit it.
 *
 * This is the question an auto-fit asks — "how big does this box have to be"
 * — and it is deliberately a named function rather than a layout option or a
 * degenerate-height trick. Laying a node out at `height: 1` and reading the
 * scene's bottom edge answers it too, but only because a box that small
 * cannot bound anything: the layout API cannot tell that probe apart from a
 * node someone really made 1px tall, so the escape hatch it needs was open
 * for every tiny node as well. A node that needs `h` of content is contained
 * by a height of `h + 2 * geometry.paddingPx`.
 *
 * Chrome is excluded (it spans the stored box by definition, so including it
 * could never report "the content is shorter than its box"), and so is a
 * label placed ABOVE the frame — that is not content in the box.
 */
export function naturalNodeContentSize(
  node: SpatialNode,
  options: SpatialLayoutOptions,
): { readonly w: number; readonly h: number } {
  const content = composeNode(node, {
    ...options,
    geometry: resolveGeometry(options.geometry),
    parseBody: options.parseBody ?? parseMarkdownBody,
    highlightCode: options.highlightCode ?? highlightCode,
    embedPath: new Set(),
    embedDepth: 0,
    fitToBox: false,
  }).filter(
    (entry): entry is Exclude<SceneNode, { kind: 'edge' }> =>
      entry.kind !== 'shape' && entry.kind !== 'edge' && entry.bbox.y >= node.y,
  )

  if (content.length === 0) return { w: 0, h: 0 }
  const right = Math.max(...content.map((entry) => entry.bbox.x + entry.bbox.w))
  const bottom = Math.max(...content.map((entry) => entry.bbox.y + entry.bbox.h))
  const padding = resolveGeometry(options.geometry).paddingPx
  return {
    w: Math.max(0, right - (node.x + padding)),
    h: Math.max(0, bottom - (node.y + padding)),
  }
}

/** The embed path needs only the scene; the anchor map is per-top-level-canvas. */
function layoutSpatialCanvasInternalScene(
  canvas: SpatialCanvas,
  resolved: ResolvedLayoutOptions,
): Scene {
  return layoutSpatialCanvasInternal(canvas, resolved).scene
}

/** Badge geometry: a small corner mark, not content — fixed, not themed. */
/**
 * The context a decoration is given. `bounds` is the node's CONTENT box, so a
 * silhouette insets a decoration exactly as it insets text; `label` is the
 * resolved label appearance, so ink that should match the node's text can.
 */
export interface DecorationContext {
  readonly bounds: BoundingBox
  readonly label: Appearance
}

/** A plugin's mark on a node. Returns scene nodes in this package's own
 *  vocabulary — the union stays closed, contributions build from it. */
export type NodeDecoration = (node: SpatialNode, context: DecorationContext) => readonly SceneNode[]

function composeDecorations(
  node: SpatialNode,
  options: ResolvedLayoutOptions,
): readonly SceneNode[] {
  const decorations = options.decorations ?? visualDecorations
  if (decorations.length === 0) return []
  const context: DecorationContext = {
    bounds: nodeContentBounds(node, options),
    label: options.appearance.resolveLabel(),
  }
  return decorations.flatMap((decorate) => decorate(node, context))
}

function layoutSpatialCanvasInternal(
  canvas: SpatialCanvas,
  resolved: ResolvedLayoutOptions,
): { scene: Scene; anchors: ReadonlyMap<string, EdgeAnchorPair> } {
  const nodeContent = canvas.nodes.flatMap((node) => [
    ...composeNode(node, resolved),
    ...composeDecorations(node, resolved),
  ])
  const { content, anchors } = composeEdgesAndLabels(canvas, resolved)
  return { scene: { nodes: [...nodeContent, ...content] }, anchors }
}

function composeEdgesAndLabels(
  canvas: SpatialCanvas,
  resolved: ResolvedLayoutOptions,
): { content: SceneNode[]; anchors: ReadonlyMap<string, EdgeAnchorPair> } {
  // One anchor pass for the whole edge set: fan-out needs to see every end
  // sharing a side, which a per-edge route cannot.
  // Facet-aware by DEFAULT (visual.edges/v0 first, legacy edgeRouting
  // fallback): resolution lives here rather than at the call sites for the
  // same reason the tokeniser default does — every surface that lays a
  // canvas out wants it, and the one that forgets draws different routes.
  const edgeStyle = resolveCanvasEdgeStyle(canvas)
  const anchors = assignEdgeAnchors(
    canvas.nodes,
    canvas.edges,
    edgeStyle.style,
    resolved.edgeSideOverrides,
  )
  const routedEdges = canvas.edges.map((edge) =>
    composeEdge(canvas, edge, resolved, edgeStyle.style, anchors.get(edge.id)),
  )
  // Canvas-wide today; the same resolution is where a per-edge
  // x-whiteboard override slots in later without touching the pipeline.
  const lineJumps = edgeStyle.lineJumps ?? 'none'
  const jumpsByEdge = lineJumps === 'arc' ? computeEdgeJumps(routedEdges) : undefined
  const edgeContent =
    jumpsByEdge === undefined
      ? routedEdges
      : routedEdges.map((edge) => {
          const jumps = jumpsByEdge.get(edge.id)
          return jumps === undefined ? edge : { ...edge, jumps }
        })
  const labelContent = canvas.edges
    .map((edge, index) => composeEdgeLabel(edge, edgeContent[index]!, resolved))
    .filter((label): label is TextRunNode => label !== undefined)
  return { content: [...edgeContent, ...labelContent], anchors }
}

/**
 * The edge-and-label suffix of `layoutSpatialCanvas`'s scene, on its own:
 * routing, line jumps, and centered labels through the exact code path the
 * full layout uses, without laying out any node content. This exists for a
 * consumer that already has the node layer rendered and needs ONLY the
 * edges recomputed against updated node positions (the editor's live drag
 * overlay) — a second edge pipeline there would drift from the committed
 * result, which is the one-producer-per-geometry rule this export upholds.
 */
export function layoutSpatialEdges(
  canvas: SpatialCanvas,
  options: SpatialLayoutOptions,
): SceneNode[] {
  return composeEdgesAndLabels(canvas, {
    ...options,
    geometry: resolveGeometry(options.geometry),
    parseBody: options.parseBody ?? parseMarkdownBody,
    highlightCode: options.highlightCode ?? highlightCode,
    embedPath: new Set(),
    embedDepth: 0,
    fitToBox: true,
  }).content
}

/**
 * The effective silhouette per node, as a NAMESPACED shape id.
 *
 * The id is composed, never stored: a facet key supplies the namespace and
 * its payload the bare kind, so `visual.shape/v0` holding `diamond` resolves
 * `visual.diamond`. A document therefore cannot name another plugin's
 * geometry by writing an id into a payload — the payload never carries one.
 *
 * An explicit `nodeOutlines` entry still overrides the facet for that node,
 * and is already a full id.
 *
 * ponytail: the bundled facet goes through `resolveNodeShape`, which applies
 * the engine's compat chain and schema before yielding a kind, while a
 * caller-declared facet is read raw and gated only by whether its composed id
 * is in the shape table. Both readers accept the same set today. The
 * asymmetry disappears when a plugin supplies its own validated reader
 * alongside its shapes, which is the increment that also lets this package
 * stop importing `plugin-visual`.
 */
function resolveNodeOutlines(
  canvas: SpatialCanvas,
  explicit: Readonly<Record<string, string>> | undefined,
  shapeFacets: readonly string[] | undefined,
): Readonly<Record<string, string>> | undefined {
  let fromFacets: Record<string, string> | undefined
  for (const node of canvas.nodes) {
    const kind = resolveNodeShape(node)
    if (kind !== undefined) {
      fromFacets ??= {}
      fromFacets[node.id] = `${VISUAL_NAMESPACE}.${kind}`
    }
    for (const facetKey of shapeFacets ?? []) {
      const composed = composeShapeId(node, facetKey)
      if (composed === undefined) continue
      fromFacets ??= {}
      fromFacets[node.id] = composed
    }
  }
  if (fromFacets === undefined) return explicit
  return explicit === undefined ? fromFacets : { ...fromFacets, ...explicit }
}

/** The namespace of a facet key is everything before its first dot. */
function composeShapeId(node: SpatialNode, facetKey: string): string | undefined {
  const stored = node['x-whiteboard']?.facets?.[facetKey]
  if (stored === null || typeof stored !== 'object') return undefined
  const kind = (stored as { readonly kind?: unknown }).kind
  if (typeof kind !== 'string' || kind === '') return undefined
  const namespace = facetKey.slice(0, facetKey.indexOf('.'))
  return namespace === '' ? undefined : `${namespace}.${kind}`
}
