/**
 * The wire between the editor and the layout worker.
 *
 * Everything here is structured-cloneable BY CONSTRUCTION, which is the
 * constraint that shapes it: `renderCanvasToSvg` takes FUNCTION seams
 * (`resolveReference`, `expandFileNode`) and a function cannot cross a
 * `postMessage`. Only the parts whose input is plain data — the
 * file-reference label table and the dangling-ref list — are carried here
 * and rebuilt worker-side by `composeReferenceSeam`; a canvas whose host
 * resolves reference CONTENT falls back to main-thread layout rather than
 * silently rendering without it (see `canLayoutInWorker`).
 *
 * Markdown text crosses as part of the canvas and the WORKER parses it, so
 * parse and layout leave the main thread together. The old blocker was never
 * remark itself: decode-named-character-reference's `browser` entry touches
 * `document` at module top level, and vite.config.ts now pins the DOM-free
 * build (see workerSafeEntityDecoder there).
 *
 * Transport is plain postMessage, i.e. structuredClone. That was measured
 * rather than assumed: 0.90ms to clone the scene of a 60-node/200-edge canvas
 * against 339ms to lay it out, and encoding to a transferable byte array
 * instead saves 0.4ms of that. At 0.12% of the work, the simplest transport
 * wins — and structuredClone also preserves `undefined`-valued keys, Maps and
 * Dates that a JSON round trip would quietly drop.
 */

import type {
  BoundingBox,
  EdgeAnchorPair,
  ResolvedReference,
  Scene,
} from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { ResolvedTheme } from '../hooks/useThemeMode.js'

/** Opaque file reference -> readable label, the plain-data form of the seam. */
export type FileRefLabel = { readonly file: string; readonly label: string }

export type LayoutRequest = {
  readonly type: 'layout'
  /** Echoed back so a late reply for a superseded canvas can be dropped. */
  readonly id: number
  readonly canvas: SpatialCanvas
  readonly theme: ResolvedTheme
  readonly fileRefLabels?: readonly FileRefLabel[]
  /** File refs the host resolved as dangling — the plain-data form of the
   * seam's `missing` field, precomputed against THIS canvas's file nodes
   * (a function cannot cross the wire; a small ref list can). */
  readonly missingFileRefs?: readonly string[]
}

/**
 * Lay a markdown BODY out, for the editor's rail.
 *
 * Only the block boxes and their source lines come back — no SVG. The rail
 * draws rectangles, and a document's worth of serialized SVG per keystroke
 * is a cost with no reader.
 *
 * The resolver seams (`resolveAlias`, `resolveEmbed`, math, diagrams) do NOT
 * cross: they are functions, and the rail does not need them. An unresolved
 * reference lays out as the literal text the author typed, which shifts a
 * block's width slightly and never its position — a difference no minimap
 * can show. The PREVIEW's own layout stays the source of truth wherever one
 * is on screen; this exists for write mode, where none is.
 */
export type MarkdownRailRequest = {
  readonly type: 'markdown-rail'
  readonly id: number
  readonly body: string
  readonly maxWidth: number
}

export type MarkdownRailResponse =
  | {
      readonly type: 'markdown-rail-done'
      readonly id: number
      readonly blocks: readonly { x: number; y: number; w: number; h: number }[]
      readonly anchors: readonly { line: number; y: number }[]
    }
  | { readonly type: 'failed'; readonly id: number; readonly reason: string }

/**
 * Render a markdown BODY to SVG.
 *
 * The sibling `markdown-rail` request deliberately returns no SVG, and its
 * reasoning still holds where it was written: the rail redraws per keystroke
 * and draws rectangles, so serializing a document's worth of SVG for it
 * would be a cost with no reader. A row thumbnail HAS a reader — the SVG is
 * the picture — and it is produced once per document, not per keystroke.
 *
 * The resolver seams do not cross here either, for the same reason (a
 * function cannot be posted). An unresolved reference draws as the literal
 * text the author typed, which at thumbnail scale is a difference no eye can
 * find.
 */
export type MarkdownRenderRequest = {
  readonly type: 'markdown-render'
  readonly id: number
  readonly body: string
  readonly maxWidth: number
}

export type MarkdownRenderResponse =
  | {
      readonly type: 'markdown-render-done'
      readonly id: number
      readonly svg: string
      /** What the SVG's own viewBox covers, so a caller can scale it. */
      readonly bounds: BoundingBox
    }
  | { readonly type: 'failed'; readonly id: number; readonly reason: string }

export type LayoutResponse =
  | {
      readonly type: 'laid-out'
      readonly id: number
      readonly svg: string
      readonly bounds: BoundingBox
      readonly scene: Scene
      /** The layout's own anchor pass, carried out with the scene: Maps
       * survive structuredClone, and the drag overlay pins bystander edges
       * to exactly these without re-running the pass on the main thread. */
      readonly anchors: ReadonlyMap<string, EdgeAnchorPair>
    }
  | {
      // A worker that throws, or that is asked to lay out a body nobody
      // pre-parsed, must not leave the editor waiting — and must never guess.
      // The caller lays the same canvas out on the main thread instead, so
      // either failure costs responsiveness and never content.
      readonly type: 'failed'
      readonly id: number
      readonly reason: string
    }

/**
 * Why a worker refused. `font-degraded` is the one worth distinguishing: it
 * means this realm could not register the vendored face, so the worker would
 * measure with a system font and hand back a scene that disagrees with what an
 * export of the same canvas produces. Wrong pixels are not a slower frame, so
 * the caller must stop asking rather than retry.
 */
export const FONT_DEGRADED = 'font-degraded'

/**
 * The reference seam, layered: whatever CONTENT the host resolved, with the
 * plain-data chrome (readable labels, dangling refs) on top.
 *
 * ONE producer for both threads. The worker rebuilds its seam from the two
 * lists in the request and the main thread builds the same seam from the
 * callbacks it has; two hand-written compositions of "label overrides
 * content" is exactly how the offloaded and synchronous renders of one
 * canvas start disagreeing about what it says.
 *
 * Returns `undefined` when nothing is supplied, so a host that wires none
 * leaves the layout exactly as it was before any of this existed.
 */
export function composeReferenceSeam(parts: {
  readonly content?: (ref: string) => ResolvedReference | undefined
  readonly labels?: ReadonlyMap<string, string>
  readonly missing?: ReadonlySet<string>
}): ((ref: string) => ResolvedReference | undefined) | undefined {
  const { content, labels, missing } = parts
  const hasLabels = labels !== undefined && labels.size > 0
  const hasMissing = missing !== undefined && missing.size > 0
  if (content === undefined && !hasLabels && !hasMissing) return undefined
  return (ref) => {
    const resolved = content?.(ref)
    const label = hasLabels ? labels.get(ref) : undefined
    const isMissing = hasMissing && missing.has(ref)
    if (resolved === undefined && label === undefined && !isMissing) return undefined
    return {
      ...resolved,
      ...(label !== undefined ? { label } : {}),
      ...(isMissing ? { missing: true } : {}),
    }
  }
}

/**
 * Whether a canvas's render options can cross the wire at all.
 *
 * The CONTENT seam is supplied by a host page and cannot be serialized, so
 * a canvas that could call it has to be laid out on the main thread —
 * shipping a scene rendered WITHOUT a seam the caller wired would be a
 * silent content regression, worse than the jank this worker exists to
 * remove. Labels and dangling refs are exempt because they already cross as
 * data and the worker rebuilds them through `composeReferenceSeam`.
 */
export function canLayoutInWorker(
  options: {
    readonly resolveReferenceContent?: unknown
    readonly expandFileNode?: unknown
  },
  canvas: SpatialCanvas,
): boolean {
  // The seam only disqualifies a canvas that could actually CALL it: it is
  // keyed on a file reference, so a canvas without a file node lays out
  // identically with or without it. This is judged per canvas rather than
  // per host because the real pages supply the seam UNCONDITIONALLY
  // (useDocumentFileSeams returns it whether or not any file node exists) — a
  // presence check reads as "this host has file support" and silently turns
  // the worker off for every production canvas.
  const hasFileNode = canvas.nodes.some((node) => node.type === 'file')
  if (!hasFileNode) return true
  return options.resolveReferenceContent === undefined && options.expandFileNode === undefined
}
