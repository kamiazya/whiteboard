/**
 * How ONE node's box is drawn and filled: the chrome shape, the label run,
 * the text body, the file embed and its miniature, the facet card, the group
 * background, and `composeNode`, which chooses between them.
 *
 * The composer's other half, so it sits beside `spatial-canvas.ts` rather
 * than under `layout/nodes/`: it reads the composer's shared vocabulary
 * (`layout-options`, the scene transforms, the ink seed), which a `nodes/`
 * primitive may not reach up to (`layer-boundary.test.ts`).
 *
 * A nested canvas — a file embed, a body's `![[canvas]]` — is laid out by the
 * composer's own entry, taken as `options.layoutNestedCanvas` rather than
 * imported: `spatial-canvas.ts` imports this module, so importing it back
 * would close a value cycle. `comments.ts` and `proposals.ts` take the body
 * typesetter the same way.
 */

import { resolveReferences } from '@kamiazya/whiteboard-codec'
import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import {
  frameBackground,
  frameBackgroundStyle,
  frameLabel,
  isFrame,
  nodeFile,
  nodeKind,
  nodeSubpath,
  nodeText,
  nodeUrl,
} from '@kamiazya/whiteboard-model'
import type { MdastFlowContent, MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import type {
  BoundingBox,
  Scene,
  SceneInk,
  SceneNode,
  ShapeSceneNode,
  TextRunNode,
} from '@kamiazya/whiteboard-scene'
import { referenceFor as resolveOneReference } from '../references/seams.js'
import { markdownTheme } from '../theme/theme-asset.js'
import type { ResolvedLayoutOptions, ResolvedReference } from './layout-options.js'
import {
  type EmbeddedCanvasBox,
  type EmbeddedCanvasMiniature,
  type FittedBlocks,
  firstLineOfBlocks,
  fitBlocksToHeight,
  layoutMdastBlocks,
  type MdastLayoutOptions,
} from './nodes/mdast-blocks.js'
import { outlineContentBox } from './nodes/node-outline.js'
import { fitToWidth } from './nodes/truncate.js'
import { collectTextRuns, composePassageHighlights, type NodePassage } from './passage-highlight.js'
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

function composeTextNode(node: SpatialNode, options: ResolvedLayoutOptions): readonly SceneNode[] {
  // The editor overlay owns this node's text: draw the chrome alone, with
  // no truncation mark — there is no drawn text for the mark to be about.
  if (options.suppressedBodyNodeIds?.includes(node.id)) return [chromeShape(node, options)]
  // Bound once: this function reads it three times, and the accessor exists
  // so no reader spells where the text is stored.
  const text = nodeText(node) ?? ''
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
          text,
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
        resolveReferences(options.parseBody(text), options.resolveAlias),
        mdastOptionsFor(maxWidth, options),
      )
      body = fitTextBody(laid, node, options)
      if (cacheKey !== undefined) options.contentCache?.set(cacheKey, body)
    } catch (err) {
      options.onDegrade?.({ kind: 'body-parse-failed', nodeId: node.id, err })
      body = fitTextBody({ nodes: [labelRun(text, options, maxWidth)] }, node, options)
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

export function groupPassages(
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
function labelOf(node: SpatialNode, resolved: ResolvedReference | undefined): string | undefined {
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
  node: SpatialNode,
  resolved: ResolvedReference | undefined,
  options: ResolvedLayoutOptions,
): SceneNode | undefined {
  const child = resolved?.canvas
  if (child === undefined) return undefined
  if (options.expandFileNode?.(node) !== true) return undefined
  const file = nodeFile(node)
  if (
    file === undefined ||
    options.embedDepth >= FILE_EMBED_DEPTH_CAP ||
    options.activeEmbedPath.has(file)
  ) {
    return undefined
  }

  const childScene = options.layoutNestedCanvas(child, {
    ...options,
    // Silhouettes resolve per CANVAS (in withCanvasTheme), keyed by that
    // canvas's own node ids: spreading the parent's map both drops the
    // child's facets and leaks a same-id root node's shape into the embedded
    // canvas. Explicit per-node overrides are root-keyed by contract, so
    // they do not descend.
    explicitNodeOutlines: undefined,
    activeEmbedPath: new Set([...options.activeEmbedPath, file]),
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
    documentId: file,
    children: fitted.nodes,
  }
}

/** The image rendering of a file node: fills the padded box, aspect kept. */
function composeFileImage(
  node: SpatialNode,
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
  node: SpatialNode,
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
  node: SpatialNode,
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
  node: SpatialNode,
  options: ResolvedLayoutOptions,
): SceneNode | undefined {
  const background = frameBackground(node)
  if (background === undefined) return undefined
  const image = referenceFor(background, options)?.image
  if (image === undefined) return undefined
  if (!(node.width > 0) || !(node.height > 0)) return undefined
  const backgroundStyle = frameBackgroundStyle(node)
  if (backgroundStyle === 'repeat') {
    options.onDegrade?.({ kind: 'unsupported-background-style', nodeId: node.id, style: 'repeat' })
  }
  return {
    kind: 'image',
    bbox: { x: node.x, y: node.y, w: node.width, h: node.height },
    href: image.href,
    ...(image.alt !== undefined ? { alt: image.alt } : {}),
    fit: backgroundStyle === 'ratio' ? 'contain' : 'cover',
  }
}

export function composeNode(
  node: SpatialNode,
  options: ResolvedLayoutOptions,
): readonly SceneNode[] {
  // Dispatches on what a node HOLDS rather than on the stored discriminant,
  // so this switch says the same thing before and after ADR-0038 decision 3
  // dissolves that union. `NodeKind` is closed, so it still narrows to
  // `never` — the exhaustiveness the defensive arm below is measured against
  // survives the move.
  switch (nodeKind(node)) {
    case 'file': {
      // Resolved ONCE per node and threaded through every rank below. The
      // seams this replaced re-asked for the same key at each rank, which
      // meant a caller's lookup ran four times per file node.
      //
      // The `?? ''` is unreachable rather than a default: `nodeKind` answered
      // `file`, and that kind IS "has a location", so the accessor cannot be
      // empty here. It resolves to nothing if it ever were, which is the same
      // never-throw degradation the arms below already take.
      const resolved = referenceFor(nodeFile(node) ?? '', options)
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
    case 'text':
      return composeTextNode(node, options)
    case 'frame': {
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
      // Defensive branch: `NodeKind` is closed, so this is unreachable for
      // schema-valid input. Kept so an unrecognized kind (a value cast past
      // the type system) still degrades to chrome-only rather than throwing.
      options.onDegrade?.({
        kind: 'unknown-node-kind',
        nodeId: node.id,
        // The media type is what a reader needs here: `nodeKind` answers
        // `undefined` precisely when nothing claims the resource, so naming
        // the kind would say nothing at all.
        type: node.resource?.mimeType ?? 'none',
      })
      return [chromeShape(node, options)]
    }
  }
}
