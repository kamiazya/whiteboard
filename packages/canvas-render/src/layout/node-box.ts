/**
 * How ONE node's box is drawn, whatever it holds: the chrome shape, the label
 * run, where content sits inside the box (and a container's label above it),
 * the content bounds a shaped node inscribes, and the fit that cuts what
 * cannot fit — the pieces `compose-node.ts` (text, frame, link) and
 * `compose-file-node.ts` (a file's representations) are both built from.
 *
 * Below both of them on purpose: each needs these, and `composeNode` needs
 * each, so keeping these in `compose-node.ts` would have made the file-node
 * module and its dispatcher import one another.
 */

import {
  frameLabel,
  isFrame,
  nodeFile,
  nodeSubpath,
  nodeUrl,
  type SpatialCanvas,
  type SpatialNode,
} from '@kamiazya/whiteboard-model'
import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import type {
  BoundingBox,
  Scene,
  SceneInk,
  SceneNode,
  ShapeSceneNode,
  TextRunNode,
} from '@kamiazya/whiteboard-scene'
import type { ResolvedReference } from '../references/resolved.js'
import { referenceFor as resolveOneReference } from '../references/seams.js'
import { markdownTheme } from '../theme/theme-asset.js'
import type { ResolvedLayoutOptions } from './layout-options.js'
import { type FittedBlocks, fitBlocksToHeight, layoutMdastBlocks } from './nodes/mdast-blocks.js'
import type {
  EmbeddedCanvasBox,
  EmbeddedCanvasMiniature,
  MdastLayoutOptions,
} from './nodes/mdast-layout-options.js'
import { outlineContentBox } from './nodes/node-outline.js'
import { fitToWidth } from './nodes/truncate.js'
import { fitSceneIntoBox } from './scale-scene.js'
import { seedFromId } from './seed.js'
import { translateScene } from './translate-scene.js'

export function mdastOptionsFor(
  maxWidth: number,
  options: ResolvedLayoutOptions,
): MdastLayoutOptions {
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
  const scene = options.layoutNestedCanvas(canvas, {
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
export function nodeContentBounds(node: SpatialNode, options: ResolvedLayoutOptions): BoundingBox {
  const box = { x: node.x, y: node.y, w: node.width, h: node.height }
  if (!options.fitToBox) return box
  return outlineContentBox(options.nodeOutlines?.[node.id], box, options.shapeTable)
}

export function contentWidth(node: SpatialNode, options: ResolvedLayoutOptions): number {
  const width = nodeContentBounds(node, options).w - 2 * options.geometry.paddingPx
  const floor = options.geometry.minContentWidthPx
  return Number.isFinite(width) && width > floor ? width : floor
}

export function chromeShape(node: SpatialNode, options: ResolvedLayoutOptions): ShapeSceneNode {
  const resolved = options.appearance.resolveNode(node)
  const shape = options.nodeOutlines?.[node.id]
  // A coloured node is hatched over its tint under a pencil; a group is a
  // frame around its members, never a filled box, so its colour stays on the line.
  const ink = sketchInkFor(node.id, options, node.color !== undefined && !isFrame(node))
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
export function sketchInkFor(
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
export function labelRun(
  text: string,
  options: ResolvedLayoutOptions,
  maxWidth: number,
): TextRunNode {
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
    bbox: { x: 0, y: 0, w: metrics.advanceWidth, h: metrics.ascent + metrics.descent },
    baseline: metrics.ascent,
    text: fitted.text,
    ...(fitted.truncated ? { truncated: true as const } : {}),
    ...(fitted.overflows ? { overflows: true as const } : {}),
    appearance: { ...labelAppearance, fontSize: options.geometry.labelFontSizePx },
  }
}

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
export function chromeWithFit(
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

export function placeInNode(
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
export function placeAboveNode(node: SpatialNode, content: Scene): readonly SceneNode[] {
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
 * The caller's resolution for one reference. The guard itself lives in
 * `references/` — a body's inline image resolves through the same one, and
 * a second copy would be a second answer to "what does a throwing seam do".
 */
export function referenceFor(
  ref: string,
  options: ResolvedLayoutOptions,
): ResolvedReference | undefined {
  return resolveOneReference(ref, options.resolveReference)
}

/** The readable label of a non-text node, or `undefined` when it has none. */
export function labelOf(
  node: SpatialNode,
  resolved: ResolvedReference | undefined,
): string | undefined {
  const file = nodeFile(node)
  if (file !== undefined) {
    // The raw reference is an opaque id — useless to a reader — and the
    // subpath is moot without a target, so neither appears.
    if (resolved?.missing === true) return 'Missing reference'
    const base = resolved?.label ?? file
    const subpath = nodeSubpath(node)
    return subpath ? `${base}${subpath}` : base
  }
  const url = nodeUrl(node)
  if (url !== undefined) return url
  const label = frameLabel(node)
  return label !== undefined && label.length > 0 ? label : undefined
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
export function fitSceneInNode(
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

export function fitBodyInNode(
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

/** A node's label drawn above the box or inside it; nothing when it has none. */
export function labelRuns(
  node: SpatialNode,
  label: string | undefined,
  where: 'above' | 'inside',
  options: ResolvedLayoutOptions,
): readonly SceneNode[] {
  if (label === undefined) return []
  return where === 'above'
    ? placeAboveNode(node, { nodes: [labelRun(label, options, node.width)] })
    : placeInNode(node, { nodes: [labelRun(label, options, contentWidth(node, options))] }, options)
}
