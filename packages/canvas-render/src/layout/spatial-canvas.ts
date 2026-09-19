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

import { parseMarkdownBody, resolveReferences } from '@kamiazya/whiteboard-codec'
import type { ThemeTokens } from '@kamiazya/whiteboard-facet-engine'
import type { EdgeRoutingStyle, SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { endNode } from '@kamiazya/whiteboard-model'
import type { MdastFlowContent, MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import type { VisualEdgesFacet } from '@kamiazya/whiteboard-plugin-visual'
import { resolveCanvasEdgeStyle, resolveEdgeOwnStyle } from '@kamiazya/whiteboard-plugin-visual'
import { visualRenderContribution } from '@kamiazya/whiteboard-plugin-visual/render'
import type {
  BoundingBox,
  DecorationContext,
  EdgeRouter,
  NodeDecoration,
  RenderContribution,
  ResolvedEdgeNode,
  RoutableElement,
  Scene,
  SceneInk,
  SceneNode,
  ShapeSceneNode,
  TextRunNode,
} from '@kamiazya/whiteboard-scene'
import { highlightCode } from '../highlight/lowlight.js'
import { canvasLegend } from '../legend/canvas-legend.js'
import { referenceFor as resolveOneReference, withReferenceSeams } from '../references/seams.js'
import { sceneBounds } from '../scene-bounds.js'
import { withDeclaredColours } from '../tags/declared-colours.js'
import { SPATIAL_THEME_FONT_FAMILY } from '../theme/font-family.js'
import { SPATIAL_THEME_GEOMETRY, type SpatialGeometry } from '../theme/spatial-geometry.js'
import {
  SPATIAL_DARK_PALETTE,
  SPATIAL_LIGHT_PALETTE,
  type SpatialPalette,
} from '../theme/spatial-palette.js'
import type { SpatialThemeMode } from '../theme/spatial-theme.js'
import { createThemedAppearance, markdownTheme, paletteFromTokens } from '../theme/theme-asset.js'
import { composeComments, composeRegionOutlines, regionsOf } from './comments.js'
import { contributedRoute, resolveRouterTable } from './contributed-router.js'
import { flattenDrawnEdgePath } from './edges/edge-flatten.js'
import { computeEdgeJumps } from './edges/edge-jumps.js'
import { edgeLabelPlacement, labelObstacles } from './edges/edge-label-anchor.js'
import { assignEdgeAnchors, type EdgeAnchorPair, routeEdge } from './edges/spatial-edges.js'
import type {
  ResolvedLayoutOptions,
  ResolvedReference,
  SpatialLayoutOptions,
  SpatialRenderStyle,
} from './layout-options.js'
import {
  type EmbeddedCanvasBox,
  type EmbeddedCanvasMiniature,
  type FittedBlocks,
  firstLineOfBlocks,
  fitBlocksToHeight,
  layoutMdastBlocks,
  type MdastLayoutOptions,
} from './nodes/mdast-blocks.js'
import {
  outlineContentBox,
  outlineEntryPoint,
  type ShapeContribution,
  type ShapeTable,
} from './nodes/node-outline.js'
import type { SpatialAppearanceResolver } from './nodes/spatial-appearance.js'
import { fitToWidth } from './nodes/truncate.js'
import {
  collectTextRuns,
  composePassageHighlights,
  type NodePassage,
  nodePassagesOf,
} from './passage-highlight.js'
import { composeProposals } from './proposals.js'
import { scaleScene } from './scale-scene.js'
import { seedFromId } from './seed.js'
import { translateScene } from './translate-scene.js'

export {
  COMMENT_TEXT_MAX_WIDTH_PX,
  type CommentBodyLayoutOptions,
  layoutCommentBody,
} from './comment-body.js'
export { COMMENT_BUBBLE_OFFSET_PX } from './comment-placement.js'

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
  const label = options.appearance.resolveLabel()
  const syntax = options.appearance.resolveSyntax?.()
  return {
    measure: options.measure,
    maxWidth,
    // A body's FURNITURE takes the canvas's theme too, not only its prose.
    theme: markdownTheme(options.activeTheme?.tokens, options.appearance.mode),
    // Body content is measured and declared with the SAME family the label
    // path resolves, so one theme drives every glyph in a node — and painted
    // with the SAME fill, for the same reason. `resolveLabel` is already the
    // seam for "a degraded body fallback run"; a body that renders owes its
    // colour to the same producer as one that does not.
    fontFamily: label.fontFamily ?? 'sans-serif',
    ...(label.fill === undefined ? {} : { textFill: label.fill }),
    ...(syntax === undefined ? {} : { syntax }),
    ...(options.highlightCode !== undefined ? { highlightCode: options.highlightCode } : {}),
    ...(options.renderMath !== undefined ? { renderMath: options.renderMath } : {}),
    ...(options.renderDiagram !== undefined ? { renderDiagram: options.renderDiagram } : {}),
    ...(options.references !== undefined ? { references: options.references } : {}),
    ...(options.resolveEmbed !== undefined ? { resolveEmbed: options.resolveEmbed } : {}),
    ...(options.resolveTitle !== undefined ? { resolveTitle: options.resolveTitle } : {}),
    embedPath: [...options.activeEmbedPath],
    layoutEmbeddedCanvas: (canvas, box) => layoutCanvasMiniature(canvas, box, options),
  }
}

/**
 * The composer's half of a markdown body's `![[canvas]]`: the referenced
 * canvas laid out with the SAME contributions and seams as the canvas the
 * body sits in, on the recursion path the typesetter hands back, and fitted
 * into the box it reserved. What the file-node miniature does for a node,
 * for a block of prose.
 */
function layoutCanvasMiniature(
  canvas: SpatialCanvas,
  box: EmbeddedCanvasBox,
  options: ResolvedLayoutOptions,
): EmbeddedCanvasMiniature | undefined {
  const scene = layoutSpatialCanvasInternalScene(canvas, {
    ...options,
    // Per-canvas silhouettes, for the reason composeFileEmbed gives.
    explicitNodeOutlines: undefined,
    activeEmbedPath: new Set(box.embedPath),
    embedDepth: box.embedPath.length,
  })
  return fitSceneIntoBox(scene, box)
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
  return outlineContentBox(options.nodeOutlines?.[node.id], box, options.shapeTable)
}

function contentWidth(node: SpatialNode, options: ResolvedLayoutOptions): number {
  const width = nodeContentBounds(node, options).w - 2 * options.geometry.paddingPx
  const floor = options.geometry.minContentWidthPx
  return Number.isFinite(width) && width > floor ? width : floor
}

function chromeShape(node: SpatialNode, options: ResolvedLayoutOptions): ShapeSceneNode {
  const resolved = options.appearance.resolveNode(node)
  const shape = options.nodeOutlines?.[node.id]
  // A coloured node is hatched over its tint under a pencil; a group is a
  // frame around its members, never a filled box, so its colour stays on the line.
  const ink = sketchInkFor(node.id, options, node.color !== undefined && node.type !== 'group')
  return {
    kind: 'shape',
    id: node.id,
    bbox: { x: node.x, y: node.y, w: node.width, h: node.height },
    ...(resolved.radius !== undefined ? { radius: resolved.radius } : {}),
    ...(shape !== undefined ? { shape } : {}),
    ...(resolved.appearance !== undefined ? { appearance: resolved.appearance } : {}),
    ...(ink === undefined ? {} : { ink }),
  }
}

/**
 * The ink a DOCUMENT node or edge carries under the active theme, seeded
 * from its id (decision #10: id-keyed, never positional). Only document
 * content is inked — comment and proposal chrome are built elsewhere and
 * stay crisp, so the annotation layer keeps reading as chrome.
 */
function sketchInkFor(
  id: string,
  options: ResolvedLayoutOptions,
  hatch: boolean,
): SceneInk | undefined {
  if (options.activeTheme?.tokens.ink !== 'sketch') return undefined
  return { style: 'sketch', seed: seedFromId(id), ...(hatch ? { fill: 'hatch' as const } : {}) }
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
    ...(fitted.overflows ? { overflows: true as const } : {}),
    appearance: { ...labelAppearance, fontSize: options.geometry.labelFontSizePx },
  }
}

/** Moves a node's content from its own origin to the node's padded top-left. */
/**
 * The node's chrome, carrying whether its content fits the box and whether
 * anything had to be cut for it.
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
  fit: { readonly truncated: boolean; readonly overflows: boolean },
): ShapeSceneNode {
  const chrome = chromeShape(node, options)
  return {
    ...chrome,
    ...(fit.truncated ? { truncated: true as const } : {}),
    ...(fit.overflows ? { overflows: true as const } : {}),
  }
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
  const align = options.contributions.reduce<'start' | 'center' | undefined>(
    (found, contribution) => contribution.readTextPlacement?.(node) ?? found,
    undefined,
  )
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
  return translateScene(content, node.x, node.y - CONTAINER_LABEL_GAP_PX - bottom).nodes.map(
    (entry) =>
      entry.kind === 'textRun' ? { ...entry, annotates: { kind: 'node', id: node.id } } : entry,
  )
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
  // The editor overlay owns this node's text: draw the chrome alone, with
  // no truncation mark — there is no drawn text for the mark to be about.
  if (options.suppressedBodyNodeIds?.includes(node.id)) return [chromeShape(node, options)]
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
          // A theme's family fits differently; two themes on one cache must
          // not hand each other the other's wrapped lines.
          options.appearance.resolveLabel().fontFamily ?? null,
          // The theme itself, which the family alone does not identify: one
          // naming no font of its own measures where a clean render does and
          // paints in its own ink, so the two looks would share an entry.
          options.activeTheme?.id ?? null,
        ])
  const cached = cacheKey === undefined ? undefined : options.contentCache?.get(cacheKey)
  let body: FittedBlocks
  if (cached !== undefined) {
    body = cached
  } else {
    try {
      const laid = layoutMdastBlocks(
        resolveReferences(options.parseBody(node.text), options.resolveAlias),
        mdastOptionsFor(maxWidth, options),
      )
      body = fitTextBody(laid, node, options)
      if (cacheKey !== undefined) options.contentCache?.set(cacheKey, body)
    } catch (err) {
      options.onDegrade?.({ kind: 'body-parse-failed', nodeId: node.id, err })
      body = fitTextBody({ nodes: [labelRun(node.text, options, maxWidth)] }, node, options)
    }
  }
  // Behind the runs, in the same origin-relative space, so `placeInNode`
  // carries them into the node together. A resolved passage is drawn only
  // with the resolved comments, muted like its pin.
  const passages = (options.passagesByNode.get(node.id) ?? []).filter(
    (passage) => !passage.resolved || options.showResolved === true,
  )
  const highlights =
    passages.length === 0
      ? []
      : composePassageHighlights(passages, collectTextRuns(body.nodes), options.measure, {
          open: options.appearance.resolveComment?.()?.passage,
          resolved: options.appearance.resolveComment?.()?.resolvedOverlay.passage,
        })
  return [
    chromeWithFit(node, options, body),
    ...placeInNode(node, { nodes: [...highlights, ...body.nodes] }, options),
  ]
}

function groupPassages(
  passages: readonly NodePassage[],
): ReadonlyMap<string, readonly NodePassage[]> {
  const byNode = new Map<string, NodePassage[]>()
  for (const passage of passages) {
    const list = byNode.get(passage.nodeId) ?? []
    list.push(passage)
    byNode.set(passage.nodeId, list)
  }
  return byNode
}

/**
 * The caller's resolution for one reference. The guard itself lives in
 * `references/` — a body's inline image resolves through the same one, and
 * a second copy would be a second answer to "what does a throwing seam do".
 */
function referenceFor(ref: string, options: ResolvedLayoutOptions): ResolvedReference | undefined {
  return resolveOneReference(ref, options.resolveReference)
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
  if (options.embedDepth >= FILE_EMBED_DEPTH_CAP || options.activeEmbedPath.has(node.file)) {
    return undefined
  }

  const childScene = layoutSpatialCanvasInternalScene(child, {
    ...options,
    // Silhouettes resolve per CANVAS (in withCanvasTheme), keyed by that
    // canvas's own node ids: spreading the parent's map both drops the
    // child's facets and leaks a same-id root node's shape into the embedded
    // canvas. Explicit per-node overrides are root-keyed by contract, so
    // they do not descend.
    explicitNodeOutlines: undefined,
    activeEmbedPath: new Set([...options.activeEmbedPath, node.file]),
    embedDepth: options.embedDepth + 1,
  })
  const padding = options.geometry.paddingPx
  // The reference label sits OUTSIDE the frame (see placeAboveNode), so
  // the miniature gets the whole padded box.
  const fitted = fitSceneIntoBox(childScene, {
    x: node.x + padding,
    y: node.y + padding,
    maxWidth: node.width - 2 * padding,
    maxHeight: node.height - 2 * padding,
  })
  if (fitted === undefined) return undefined
  return {
    kind: 'embedResolved',
    bbox: { x: node.x, y: node.y, w: node.width, h: node.height },
    documentId: node.file,
    children: fitted.nodes,
  }
}

/**
 * A laid-out scene scaled to fit a box (never upscaled) and placed at its
 * top-left corner. `undefined` for a degenerate fit — an empty scene, or a
 * box with no room — so the caller can draw its fallback instead. Shared by
 * the file-node miniature and the markdown body's canvas embed, which are
 * the same picture in two frames.
 */
export function fitSceneIntoBox(
  scene: Scene,
  box: Omit<EmbeddedCanvasBox, 'embedPath'>,
): EmbeddedCanvasMiniature | undefined {
  const bounds = sceneBounds(scene)
  const fit = Math.min(box.maxWidth / bounds.w, box.maxHeight / bounds.h, 1)
  if (!Number.isFinite(fit) || fit <= 0) return undefined
  const atOrigin = translateScene(scene, -bounds.x, -bounds.y)
  const scaled = scaleScene(atOrigin, fit)
  const placed = translateScene(scaled, box.x, box.y)
  return { nodes: placed.nodes, w: bounds.w * fit, h: bounds.h * fit }
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
  if (!options.fitToBox) return { nodes: scene.nodes, truncated: false, overflows: false }
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

  const chrome = chromeWithFit(node, options, body)
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

  return [chromeWithFit(node, options, body), ...placeInNode(node, { nodes: body.nodes }, options)]
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
  edge: RoutableElement,
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
  //
  // A contribution may claim this edge; a decline or a name it did not
  // register falls back to the built-in, never an error, so a document
  // written against another deployment's plugins still draws.
  const routed = pullEdgeOntoOutlines(
    contributedRoute(canvas, edge, options, anchors) ??
      routeEdge(canvas.nodes, edge, routingStyle, anchors),
    canvas,
    edge,
    options.nodeOutlines,
    options.shapeTable,
  )
  const appearance = options.appearance.resolveEdge(edge)
  const ink = sketchInkFor(edge.id, options, false)
  return {
    ...routed,
    ...(appearance === undefined ? {} : { appearance }),
    ...(ink === undefined ? {} : { ink }),
  }
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
  edge: RoutableElement,
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
  // A free end has no node, so no silhouette to be pulled onto — it already
  // sits exactly where the document put it.
  const toId = endNode(edge.to)
  const toKind = toId === undefined ? undefined : nodeOutlines[toId]
  const toBox = toKind === undefined || toId === undefined ? undefined : boxOf(toId)
  if (toKind !== undefined && toBox !== undefined) {
    const last = path[path.length - 1]
    const inward = path[path.length - 2]
    if (last !== undefined && inward !== undefined) {
      const pulled = outlineEntryPoint(toKind, toBox, inward, last, shapes)
      if (moved(pulled, last)) path = [...path.slice(0, -1), pulled]
    }
  }
  const fromId = endNode(edge.from)
  const fromKind = fromId === undefined ? undefined : nodeOutlines[fromId]
  const fromBox = fromKind === undefined || fromId === undefined ? undefined : boxOf(fromId)
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
  edge: RoutableElement,
  routed: ResolvedEdgeNode,
  options: ResolvedLayoutOptions,
  obstacles: ReturnType<typeof labelObstacles>, // what the label must not lie over
): TextRunNode | undefined {
  if (edge.label === undefined || edge.label.trim().length === 0) return undefined
  const labelAppearance = options.appearance.resolveLabel()
  const font = {
    family: labelAppearance.fontFamily ?? 'sans-serif',
    fallbackChain: [],
    weight: 400,
    style: 'normal' as const,
    sizePx: options.geometry.labelFontSizePx,
  }
  const metrics = options.measure(edge.label, font)
  const size = { w: metrics.advanceWidth, h: metrics.ascent + metrics.descent }
  const center = edgeLabelPlacement(routed.path, size, obstacles, routed.rounded === true)
  if (!center) return undefined
  return {
    kind: 'textRun',
    bbox: { x: center.x - size.w / 2, y: center.y - size.h / 2, w: size.w, h: size.h },
    baseline: metrics.ascent,
    text: edge.label,
    appearance: { ...labelAppearance, fontSize: options.geometry.labelFontSizePx },
    annotates: { kind: 'edge', id: edge.id },
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
  stored: SpatialCanvas,
  options: SpatialLayoutOptions,
): { scene: Scene; anchors: ReadonlyMap<string, EdgeAnchorPair> } {
  // Intent first, so every reader below sees the same colours.
  const canvas = withDeclaredColours(stored, options.tagLibrary)
  return layoutSpatialCanvasInternal(canvas, {
    ...withSpatialReferenceSeams(options),
    ...resolveContributions(canvas, options),
    passagesByNode: groupPassages(nodePassagesOf(options.threads ?? [])),
    regionsByThread: regionsOf(options.threads ?? [], canvas),
    messagesByThread: new Map((options.threads ?? []).map((t) => [t.id, t.messages.length])),
    geometry: resolveGeometry(options.geometry),
    parseBody: options.parseBody ?? parseMarkdownBody,
    highlightCode: options.highlightCode ?? highlightCode,
    activeEmbedPath: new Set(options.embedPath ?? []),
    embedDepth: options.embedPath?.length ?? 0,
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
  const single: SpatialCanvas = { nodes: [node], edges: [] }
  // Through the same theme resolution a layout applies: a theme's font
  // changes what fits, and a caller sizing a node under a theme passes its
  // id as `style` (the single-node canvas carries no facet to read).
  const content = composeNode(
    node,
    withCanvasTheme(single, {
      ...withSpatialReferenceSeams(options),
      // A silhouette inscribes the box its content has to fit, so the natural
      // size of a shaped node is not the natural size of the rect around it.
      ...resolveContributions(single, options),
      // A natural size asks how big the box must be; a highlight adds no
      // extent beyond the words it sits under, so none is composed here.
      passagesByNode: new Map(),
      regionsByThread: new Map(),
      messagesByThread: new Map(),
      geometry: resolveGeometry(options.geometry),
      parseBody: options.parseBody ?? parseMarkdownBody,
      highlightCode: options.highlightCode ?? highlightCode,
      activeEmbedPath: new Set(),
      embedDepth: 0,
      fitToBox: false,
    }),
  ).filter(
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

/** `SpatialLayoutOptions` with the reference bundle applied — see `withReferenceSeams`. */
function withSpatialReferenceSeams(options: SpatialLayoutOptions): SpatialLayoutOptions {
  const applied = withReferenceSeams(options)
  const seams = options.references
  if (seams === undefined) return applied
  return {
    ...applied,
    resolveAlias: options.resolveAlias ?? seams.resolveAlias,
    resolveReference: options.resolveReference ?? seams.resolveReference,
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
export type { DecorationContext, NodeDecoration, RenderContribution }

/**
 * Everything a contribution set decides ABOUT ONE CANVAS — the set, its shape
 * table, and the silhouette each node resolves to — in ONE function, so an
 * entry point omitting a piece is a type error rather than a silent omission.
 *
 * `nodeOutlines` is here rather than beside each entry point because the edge
 * overlay proved the point: resolved for the committed layout and not for
 * `layoutSpatialEdges`, so an edge into a shaped node sat on the bbox border
 * for a whole drag and snapped onto the silhouette on drop. Both call sites
 * read as complete alone; only comparing them showed the gap.
 */
function resolveContributions(
  canvas: SpatialCanvas,
  options: SpatialLayoutOptions,
): {
  contributions: readonly RenderContribution[]
  shapeTable: ShapeTable
  routerTable: Readonly<Record<string, EdgeRouter>>
  themeTable: Readonly<Record<string, ThemeTokens>>
  nodeOutlines: Readonly<Record<string, string>> | undefined
  explicitNodeOutlines: Readonly<Record<string, string>> | undefined
  baseAppearance: SpatialAppearanceResolver
} {
  const contributions = options.renderContributions ?? [visualRenderContribution]
  return {
    contributions,
    shapeTable: resolveShapeTable(contributions),
    routerTable: resolveRouterTable(contributions),
    themeTable: resolveThemeTable(contributions),
    nodeOutlines: resolveNodeOutlines(canvas, options.nodeOutlines, contributions),
    explicitNodeOutlines: options.nodeOutlines,
    baseAppearance: options.appearance,
  }
}

/** The composed theme table a contribution set resolves to, by namespaced id. */
export function resolveThemeTable(
  contributions: readonly RenderContribution[],
): Readonly<Record<string, ThemeTokens>> {
  const table: Record<string, ThemeTokens> = {}
  for (const contribution of contributions) {
    for (const [name, tokens] of Object.entries(contribution.themes ?? {})) {
      table[`${contribution.namespace}.${name}`] = tokens
    }
  }
  return table
}

/**
 * The palette ONE canvas is drawn in under a style — the theme the style
 * resolves to (`pickThemeId`: the canvas's own under `'document'`, a named
 * one, none under `'clean'`), for the mode, else the bundled palette for
 * that mode. `style` defaults to `'document'`, the editor's look.
 *
 * For an editor chrome that previews paint rather than painting: the paper
 * under the canvas, and a colour picker's swatches showing the strokes a
 * pick will produce. Resolved here so the preview and the layout read the
 * same table AND the same style; a chrome reading the saved theme while
 * the session draws clean showed neon's night under a clean board.
 */
export function resolveCanvasPalette(
  canvas: SpatialCanvas,
  mode: SpatialThemeMode,
  options: {
    readonly style?: SpatialRenderStyle
    readonly contributions?: readonly RenderContribution[]
  } = {},
): SpatialPalette {
  const contributions = options.contributions ?? [visualRenderContribution]
  const own = contributions
    .map((contribution) => contribution.readTheme?.(canvas))
    .find((id) => id !== undefined)
  const themeId = pickThemeId(options.style ?? 'document', own, undefined)
  const tokens = themeId === undefined ? undefined : resolveThemeTable(contributions)[themeId]
  if (tokens === undefined) return mode === 'dark' ? SPATIAL_DARK_PALETTE : SPATIAL_LIGHT_PALETTE
  return paletteFromTokens(tokens.palette[mode])
}

/**
 * The family the theme this canvas draws in NAMES, or nothing — the style
 * resolves to no theme, or the theme declares no family of its own.
 *
 * Separate from `resolveCanvasPalette` in ONE way that matters: an absent
 * `style` is `'clean'` here, not `'document'`. A palette is asked for by a
 * surface already drawing the document; this is asked by a tool ECHOING a
 * caller's `style`, where absent means the bundled look and so nothing for
 * the caller to go and fetch.
 */
export function resolveCanvasThemeFontFamily(
  canvas: SpatialCanvas,
  options: {
    readonly style?: SpatialRenderStyle
    readonly contributions?: readonly RenderContribution[]
  } = {},
): string | undefined {
  const contributions = options.contributions ?? [visualRenderContribution]
  const own = contributions
    .map((contribution) => contribution.readTheme?.(canvas))
    .find((id) => id !== undefined)
  const themeId = pickThemeId(options.style, own, undefined)
  const tokens = themeId === undefined ? undefined : resolveThemeTable(contributions)[themeId]
  return tokens?.fontFamily
}

/**
 * The theme id a canvas draws in, under the style the caller asked for:
 * `'clean'` never has one; a theme id IS one; `'document'` takes the
 * canvas's own, else the host's (an embed inherits), else none.
 */
function pickThemeId(
  style: SpatialRenderStyle | undefined,
  own: string | undefined,
  inherited: string | undefined,
): string | undefined {
  if (style === undefined || style === 'clean') return undefined
  if (style === 'document') return own ?? inherited
  return style
}

/**
 * Resolves the theme for ONE canvas (ADR-0030 decision 5) and re-derives
 * everything that depends on it: the appearance resolver, and the
 * silhouettes (a theme's default shape fills in where a node's facet is
 * silent). Called at every nesting level from the canvas being laid out —
 * never threaded down as an option, which is the shape that lets an outer
 * document's setting win over an embedded canvas's own.
 */
function withCanvasTheme(
  canvas: SpatialCanvas,
  resolved: ResolvedLayoutOptions,
): ResolvedLayoutOptions {
  const own = resolved.contributions
    .map((contribution) => contribution.readTheme?.(canvas))
    .find((id) => id !== undefined)
  const themeId = pickThemeId(resolved.style, own, resolved.activeTheme?.id)
  const tokens = themeId === undefined ? undefined : resolved.themeTable[themeId]
  if (themeId !== undefined && tokens === undefined) {
    resolved.onDegrade?.({ kind: 'unknown-theme', theme: themeId })
  }
  const activeTheme =
    themeId !== undefined && tokens !== undefined ? { id: themeId, tokens } : undefined
  let appearance = resolved.baseAppearance
  if (activeTheme !== undefined) {
    const wanted = activeTheme.tokens.fontFamily
    const available =
      wanted === undefined
        ? false
        : (resolved.fontAvailable ?? ((family) => family === SPATIAL_THEME_FONT_FAMILY))(wanted)
    if (wanted !== undefined && !available) {
      resolved.onDegrade?.({ kind: 'font-missing', family: wanted })
    }
    appearance = createThemedAppearance({
      tokens: activeTheme.tokens,
      mode: resolved.baseAppearance.mode ?? 'light',
      fontFamily: available && wanted !== undefined ? wanted : SPATIAL_THEME_FONT_FAMILY,
    })
  }
  // The inherited theme is REPLACED, never merged under: a child naming a
  // theme this build does not carry draws clean, so it must not keep the
  // host's ink and routing defaults beside its own clean paint.
  const { activeTheme: _inherited, ...rest } = resolved
  return {
    ...rest,
    appearance,
    ...(activeTheme === undefined ? {} : { activeTheme }),
    nodeOutlines: resolveNodeOutlines(
      canvas,
      resolved.explicitNodeOutlines,
      resolved.contributions,
      activeTheme?.tokens.defaults.nodeShape,
    ),
  }
}

/** The composed shape table a contribution set resolves to — what the SVG
 *  backend must be handed alongside the scene. */
export function resolveShapeTable(contributions: readonly RenderContribution[]): ShapeTable {
  const table: Record<string, ShapeContribution> = {}
  for (const contribution of contributions) {
    for (const [name, shape] of Object.entries(contribution.shapes ?? {})) {
      table[`${contribution.namespace}.${name}`] = shape
    }
  }
  return table
}

function composeDecorations(
  node: SpatialNode,
  options: ResolvedLayoutOptions,
): readonly SceneNode[] {
  const decorations = options.contributions.flatMap((c) => c.decorations ?? [])
  if (decorations.length === 0) return []
  const context: DecorationContext = {
    bounds: nodeContentBounds(node, options),
    label: options.appearance.resolveLabel(),
  }
  return decorations.flatMap((decorate) => decorate(node, context))
}

/**
 * Containers paint BEHIND what they hold, whatever order the canvas lists
 * them in: every group first, a larger one before a smaller (an outer group
 * before the one inside it), then everything else in stored order.
 * Stored order is a map's id order, not the order a caller wrote, so a group
 * whose id sorted after a member's painted over it once it had a colour —
 * four of eleven boxes vanished from a diagram whose grader, reading the
 * store, passed it. Equal boxes keep their stored order (the sort is
 * stable). Exported so the web app's hit-test index reads the same order.
 */
export function paintOrderOf(nodes: readonly SpatialNode[]): readonly SpatialNode[] {
  const groups = nodes
    .filter((node) => node.type === 'group')
    .sort((a, b) => b.width * b.height - a.width * a.height)
  return [...groups, ...nodes.filter((node) => node.type !== 'group')]
}

function layoutSpatialCanvasInternal(
  canvas: SpatialCanvas,
  incoming: ResolvedLayoutOptions,
): { scene: Scene; anchors: ReadonlyMap<string, EdgeAnchorPair> } {
  const resolved = withCanvasTheme(canvas, incoming)
  const nodeContent = paintOrderOf(canvas.nodes).flatMap((node) => [
    ...composeNode(node, resolved),
    ...composeDecorations(node, resolved),
  ])
  const { content, anchors } = composeEdgesAndLabels(canvas, resolved)
  // Comments LAST: the annotation layer paints above every node and edge,
  // which a flat document-order paint list can only express by position —
  // and after the edges are ROUTED, since a comment about an edge is pinned
  // on the path the edge was actually drawn along.
  const edgePaths = new Map<string, readonly { x: number; y: number }[]>()
  for (const node of content) {
    if (node.kind === 'edge' && node.id !== undefined) {
      edgePaths.set(node.id, flattenDrawnEdgePath(node.path, node.jumps, node.rounded === true))
    }
  }
  // Region outlines go under the pins, over everything they enclose.
  const regionContent = composeRegionOutlines(resolved)
  const commentContent = composeComments(
    canvas,
    resolved,
    (id) => edgePaths.get(id),
    mdastOptionsFor,
  )
  const proposalContent = composeProposals(
    canvas,
    resolved,
    (id) => edgePaths.get(id),
    mdastOptionsFor,
  )
  // The legend is the layout's answer, attached here and not in a
  // miniature: the reader of an embedded canvas has the host's corner.
  const legend = canvasLegend(canvas, resolved.appearance)
  return {
    scene: {
      nodes: [...nodeContent, ...content, ...regionContent, ...commentContent, ...proposalContent],
      ...(legend === undefined ? {} : { legend }),
    },
    anchors,
  }
}

function composeEdgesAndLabels(
  canvas: SpatialCanvas,
  resolved: ResolvedLayoutOptions,
): { content: SceneNode[]; anchors: ReadonlyMap<string, EdgeAnchorPair> } {
  // One anchor pass for the whole edge set: fan-out needs to see every end
  // sharing a side, which a per-edge route cannot.
  // Facet-aware by DEFAULT (visual.edges/v0): resolution lives here rather
  // than at the call sites for the
  // same reason the tokeniser default does — every surface that lays a
  // canvas out wants it, and the one that forgets draws different routes.
  // The theme's routing is a DEFAULT under the canvas's own facet (ADR-0030
  // decision 4): it fills in only where `visual.edges` says nothing.
  const explicitStyle = resolveCanvasEdgeStyle(canvas)
  const themeRouting = resolved.activeTheme?.tokens.defaults.edgeRouting
  const edgeStyle = {
    ...explicitStyle,
    ...(explicitStyle.style === undefined && themeRouting !== undefined
      ? { style: themeRouting }
      : {}),
  }
  // The SAME facet asked of one edge narrows the board's answer, field by
  // field (ADR-0013's edge slot). Memoised per id because the side-choice
  // search asks for an edge's style many times per layout, and each ask
  // would otherwise re-resolve and re-parse a stored payload.
  const ownStyles = new Map<string, VisualEdgesFacet>()
  const ownStyleOf = (edge: RoutableElement): VisualEdgesFacet => {
    const hit = ownStyles.get(edge.id)
    if (hit !== undefined) return hit
    const own = resolveEdgeOwnStyle(edge)
    ownStyles.set(edge.id, own)
    return own
  }
  // The side pass runs BEFORE any router does, over the whole edge set, so
  // it works in the built-in vocabulary; a contributed router receives the
  // sides it chose rather than being bound by them.
  const styleOf = (edge: RoutableElement): EdgeRoutingStyle =>
    ownStyleOf(edge).routing ?? edgeStyle.style ?? 'straight'
  // Edges AND lines, through one pipeline: the route between two places is the
  // same question whichever the element is, and the anchoring pass has to see
  // every element or two of them will pick the same side of one box.
  const routable: readonly RoutableElement[] = [...canvas.edges, ...(canvas.lines ?? [])]
  const anchors = assignEdgeAnchors(canvas.nodes, routable, styleOf, resolved.edgeSideOverrides)
  const routedEdges = routable.map((edge) =>
    composeEdge(canvas, edge, resolved, styleOf(edge), anchors.get(edge.id)),
  )
  // A jump is drawn on the LATER edge of a crossing pair, so "does this edge
  // hop" is asked of the edge that would draw the arc. Crossings are still
  // computed over EVERY edge — who crosses whom is geometry, and an edge
  // that wants no arcs of its own is still something its neighbours cross.
  const hopsOf = (edge: RoutableElement): boolean =>
    (ownStyleOf(edge).lineJumps ?? edgeStyle.lineJumps ?? 'none') === 'arc'
  const anyHops = routable.some(hopsOf)
  const jumpsByEdge = anyHops ? computeEdgeJumps(routedEdges) : undefined
  const edgeContent =
    jumpsByEdge === undefined
      ? routedEdges
      : routedEdges.map((edge, index) => {
          const jumps = jumpsByEdge.get(edge.id)
          const source = routable[index]
          if (jumps === undefined || source === undefined || !hopsOf(source)) return edge
          return { ...edge, jumps }
        })
  const obstacles = labelObstacles(canvas.nodes)
  const labelContent = routable
    .map((edge, index) => composeEdgeLabel(edge, edgeContent[index]!, resolved, obstacles))
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
  stored: SpatialCanvas,
  options: SpatialLayoutOptions,
): SceneNode[] {
  // Through the same theme resolution the full layout applies to this
  // canvas: the ink, the routing default and the paint an edge takes are
  // the theme's, and a second entry point that skipped it drew a live drag
  // crisp and straight over a pencilled, curved committed render. The
  // library's colour by intent is the same kind of thing, applied first.
  const canvas = withDeclaredColours(stored, options.tagLibrary)
  return composeEdgesAndLabels(
    canvas,
    withCanvasTheme(canvas, {
      ...withSpatialReferenceSeams(options),
      ...resolveContributions(canvas, options),
      passagesByNode: new Map(),
      regionsByThread: new Map(),
      messagesByThread: new Map(),
      geometry: resolveGeometry(options.geometry),
      parseBody: options.parseBody ?? parseMarkdownBody,
      highlightCode: options.highlightCode ?? highlightCode,
      activeEmbedPath: new Set(),
      embedDepth: 0,
      fitToBox: true,
    }),
  ).content
}

/**
 * The effective silhouette per node, as a NAMESPACED shape id.
 *
 * The id is composed, never stored: a contribution's reader answers a BARE
 * kind and its namespace prefixes it, so `visual`'s reader returning `diamond`
 * resolves `visual.diamond`. A document therefore cannot name another
 * plugin's geometry — no payload it can hold carries a namespace.
 *
 * An explicit `nodeOutlines` entry still overrides for that node, and is
 * already a full id.
 *
 * Later contributions win a contested node, which is the only ordering rule
 * this needs: a silhouette is one answer where a decoration is a stack.
 */
function resolveNodeOutlines(
  canvas: SpatialCanvas,
  explicit: Readonly<Record<string, string>> | undefined,
  contributions: readonly RenderContribution[],
  defaultShape?: string,
): Readonly<Record<string, string>> | undefined {
  let fromFacets: Record<string, string> | undefined
  for (const node of canvas.nodes) {
    let chosen: string | undefined
    for (const contribution of contributions) {
      const kind = contribution.readShape?.(node)
      if (kind === undefined) continue
      chosen = `${contribution.namespace}.${kind}`
    }
    // The theme's default is an already-namespaced id, and it fills in only
    // where the node's own facet is silent (ADR-0030 decision 4). A group is
    // a frame around other nodes, never a shaped thing itself.
    if (chosen === undefined && defaultShape !== undefined && node.type !== 'group') {
      chosen = defaultShape
    }
    if (chosen === undefined) continue
    fromFacets ??= {}
    fromFacets[node.id] = chosen
  }
  if (fromFacets === undefined) return explicit
  return explicit === undefined ? fromFacets : { ...fromFacets, ...explicit }
}

// The overlay layers and the options vocabulary live in their own modules
// now (comments.ts, proposals.ts, layout-options.ts). They are re-exported
// here because this file has been the package's layout barrel since before
// they were split out, and a move that also rewrote every importer would be
// two changes in one diff.
export {
  COMMENT_BUBBLE_PADDING_PX,
  COMMENT_BUBBLE_RADIUS_PX,
  COMMENT_PIN_COUNT_FONT_PX,
  COMMENT_PIN_SIZE_PX,
  commentAnchor,
  type EdgePathLookup,
} from './comments.js'
export type {
  FacetCardData,
  ResolvedReference,
  SpatialContentCache,
  SpatialLayoutDegradation,
  SpatialLayoutOptions,
  SpatialRenderStyle,
} from './layout-options.js'
export { spatialRenderStyleSchema } from './layout-options.js'
