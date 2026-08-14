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
 * Markdown is parsed on the MAIN thread and the mdast travels here as plain
 * data, rather than the worker importing canvas-codec. Two reasons, one
 * measured and one structural: parsing is 15-19ms of an 81-339ms layout (4-19%),
 * so leaving it behind still removes the overwhelming majority of the block;
 * and it keeps remark/unified out of the worker chunk entirely, which also
 * sidesteps their refusal to evaluate in a module worker under the dev server.
 *
 * Transport is plain postMessage, i.e. structuredClone. That was measured
 * rather than assumed: 0.90ms to clone the scene of a 60-node/200-edge canvas
 * against 339ms to lay it out, and encoding to a transferable byte array
 * instead saves 0.4ms of that. At 0.12% of the work, the simplest transport
 * wins — and structuredClone also preserves `undefined`-valued keys, Maps and
 * Dates that a JSON round trip would quietly drop.
 */

import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import type { MdastRoot } from '@kamiazya/whiteboard-canvas-model/mdast'
import type { BoundingBox, Scene } from '@kamiazya/whiteboard-canvas-render'
import type { ResolvedTheme } from '../hooks/useThemeMode.js'

/** Opaque file reference -> readable label, the plain-data form of the seam. */
export type FileRefLabel = { readonly file: string; readonly label: string }

/** A node body already turned into mdast on the main thread. */
export type ParsedBody = { readonly text: string; readonly mdast: MdastRoot }

export type LayoutRequest = {
  readonly type: 'layout'
  /** Echoed back so a late reply for a superseded canvas can be dropped. */
  readonly id: number
  readonly canvas: SpatialCanvas
  readonly theme: ResolvedTheme
  readonly fileRefLabels?: readonly FileRefLabel[]
  readonly bodies: readonly ParsedBody[]
}

export type LayoutResponse =
  | {
      readonly type: 'laid-out'
      readonly id: number
      readonly svg: string
      readonly bounds: BoundingBox
      readonly scene: Scene
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
export function canLayoutInWorker(options: {
  readonly resolveFileCanvas?: unknown
  readonly expandFileNode?: unknown
  readonly resolveFileImage?: unknown
  readonly resolveFileFacets?: unknown
}): boolean {
  return (
    options.resolveFileCanvas === undefined &&
    options.expandFileNode === undefined &&
    options.resolveFileImage === undefined &&
    options.resolveFileFacets === undefined
  )
}
