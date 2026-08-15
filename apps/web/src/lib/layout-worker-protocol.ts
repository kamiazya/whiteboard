/**
 * The wire between the editor and the layout worker.
 *
 * Everything here is structured-cloneable BY CONSTRUCTION, which is the
 * constraint that shapes it: `renderCanvasToSvg` takes five FUNCTION seams
 * (resolveFileLabel/Canvas/Image/Facets, expandFileNode) and a function
 * cannot cross a `postMessage`. Only the one seam whose input is plain data
 * — the file-reference label table — is carried here and rebuilt worker-side;
 * a canvas that needs any of the other four falls back to main-thread layout
 * rather than silently rendering without them (see `canLayoutInWorker`).
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

import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import type { BoundingBox, EdgeAnchorPair, Scene } from '@kamiazya/whiteboard-canvas-render'
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
   * resolveFileMissing seam, precomputed against THIS canvas's file nodes
   * (a function cannot cross the wire; a small ref list can). */
  readonly missingFileRefs?: readonly string[]
}

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
 * Whether a canvas's render options can cross the wire at all.
 *
 * The four function seams below are supplied by a host page. None of the
 * app's own mount sites passes one today, but an embedded editor does, and
 * shipping a scene rendered WITHOUT a seam the caller wired would be a
 * silent content regression — worse than the jank this worker exists to
 * remove.
 */
export function canLayoutInWorker(
  options: {
    readonly resolveFileCanvas?: unknown
    readonly expandFileNode?: unknown
    readonly resolveFileImage?: unknown
    readonly resolveFileFacets?: unknown
  },
  canvas: SpatialCanvas,
): boolean {
  // The seams only disqualify a canvas that could actually CALL one: every
  // seam here is keyed on a file reference, so a canvas without a file node
  // lays out identically with or without them. This is judged per canvas
  // rather than per host because the real pages supply the seams
  // UNCONDITIONALLY (useCanvasFileSeams returns them whether or not any file
  // node exists) — a presence check reads as "this host has file support"
  // and silently turns the worker off for every production canvas.
  const hasFileNode = canvas.nodes.some((node) => node.type === 'file')
  if (!hasFileNode) return true
  return (
    options.resolveFileCanvas === undefined &&
    options.expandFileNode === undefined &&
    options.resolveFileImage === undefined &&
    options.resolveFileFacets === undefined
  )
}
