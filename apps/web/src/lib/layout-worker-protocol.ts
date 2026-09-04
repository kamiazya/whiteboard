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
import type { FaviconRect } from './favicon.js'

/** Opaque file reference -> readable label, the plain-data form of the seam. */
export type FileRefLabel = { readonly file: string; readonly label: string }

/**
 * A canvas the worker should lay out, in one of two shapes.
 *
 * `canvas` is for a caller that already HOLDS one in memory — the editor,
 * whose LoroDoc is live — where exporting a snapshot just to post it would be
 * strictly worse. `snapshot` is for a caller that has only the stored bytes,
 * and hands them over without decoding: the point is not a faster render but
 * a main thread that stays free while one happens, so whatever the person is
 * doing meanwhile keeps the budget the decode was taking.
 *
 * Two measurements decide the shape, and the second is the load-bearing one:
 *
 * - Decoding on the main thread costs 1.20ms at 12 nodes, 2.60ms at 40 and
 *   4.60ms at 120 — so a list of twenty visible rows was spending 24-92ms of
 *   the thread that answers the user, to hand work to a worker that could
 *   decode it itself.
 * - Handing over the BYTES costs nothing measurable (the structured clone of
 *   the decoded object was 0.10-0.40ms; of the bytes, below measurement).
 *   That is what makes the move a release rather than a relocation — an
 *   expensive handover would simply have moved the block into the handover,
 *   and the main thread's share of a thumbnail would still not be zero.
 *
 * Exactly one of the two, which is what the union says. Decoding pulls
 * loro-crdt's WASM into the worker, so the worker imports it lazily and only
 * this shape pays for it — the editor's path and every markdown render are
 * untouched.
 */
type LayoutSubject =
  | { readonly canvas: SpatialCanvas; readonly snapshot?: undefined }
  | { readonly snapshot: Uint8Array; readonly canvas?: undefined }

export type LayoutRequest = LayoutSubject & {
  readonly type: 'layout'
  /** Echoed back so a late reply for a superseded canvas can be dropped. */
  readonly id: number
  readonly theme: ResolvedTheme
  readonly fileRefLabels?: readonly FileRefLabel[]
  /** File refs the host resolved as dangling — the plain-data form of the
   * seam's `missing` field, precomputed against THIS canvas's file nodes
   * (a function cannot cross the wire; a small ref list can). */
  readonly missingFileRefs?: readonly string[]
  /** Node ids whose body an editor overlay owns — plain data, like the refs. */
  readonly suppressedBodyNodeIds?: readonly string[]
  /** Draw resolved comments too (the editor's per-user toggle). */
  readonly showResolved?: boolean
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

/**
 * A document whose OUTLINE is wanted, in one of the three shapes a caller can
 * hold it in.
 *
 * One request rather than one per surface. A tree row's icon has only the
 * stored bytes; the tab favicon has the live canvas the page is editing; a
 * markdown document of either has a body and no boxes of its own. They differ
 * in where the document came from and in nothing else, and a pipeline that
 * forks on that is how markdown fell out of the SVG family in the first
 * place (ADR-0027).
 *
 * The `body` arm is the only one that needs a real layout pass, and so the
 * only one behind the font gate: a body measured with a system face puts its
 * blocks somewhere else. The two spatial arms are a map over boxes the
 * document already declares.
 */
type OutlineSubject =
  | { readonly canvas: SpatialCanvas; readonly snapshot?: undefined; readonly body?: undefined }
  | { readonly snapshot: Uint8Array; readonly canvas?: undefined; readonly body?: undefined }
  | {
      readonly body: string
      readonly maxWidth: number
      readonly canvas?: undefined
      readonly snapshot?: undefined
    }

export type OutlineRequest = OutlineSubject & {
  readonly type: 'outline'
  readonly id: number
}

/**
 * Rectangles in the document's own coordinates, COLOURED by the worker for
 * both kinds.
 *
 * The colour is not decoration here. A scene block has none of its own, so
 * the markdown side used to leave it absent and each consumer defaulted it
 * (or, in the tree row's case, did not) — two producers of one type that
 * differ, which is how a later consumer with no such default gets a surprise.
 * Resolving it once, on the side that produces the rects, is what makes the
 * two kinds interchangeable to every surface.
 */
export type OutlineResponse =
  | {
      readonly type: 'outlined'
      readonly id: number
      readonly rects: readonly FaviconRect[]
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
