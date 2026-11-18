// The layout's entry points: a `SpatialCanvas` laid out as a `Scene` by the
// Rust core (ADR-0054 step 7), the edge layer of a drag frame, and a node's
// natural size. Every one is answered by `options.core`; the request is built
// in `canvas-switch.ts` and the queries in `query-switch.ts`.

import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import type { Scene, SceneNode } from '@kamiazya/whiteboard-scene'
import type { CoreSvgAsk } from '../canvas-core.js'
import type { EdgeAnchorPair } from '../edge-routing.js'
import { layoutThroughCore, pictureThroughCore } from './canvas-switch.js'
import type { PicturedScene } from './core-svg.js'
import type { SpatialLayoutOptions } from './layout-options.js'
import { edgesThroughCore, naturalSizeThroughCore } from './query-switch.js'

export {
  COMMENT_BUBBLE_PADDING_PX,
  COMMENT_BUBBLE_RADIUS_PX,
  COMMENT_TEXT_MAX_WIDTH_PX,
  commentAnchor,
  type EdgePathLookup,
} from '../comment-geometry.js'

/** Composes a canvas-render `Scene` from a `SpatialCanvas`, by the core. Pure: no I/O. */
export function layoutSpatialCanvas(canvas: SpatialCanvas, options: SpatialLayoutOptions): Scene {
  return layoutSpatialCanvasWithAnchors(canvas, options).scene
}

/**
 * `layoutSpatialCanvas` with the scene's SVG, both from ONE core call: the
 * core draws the scene it laid out with its own SVG backend, in the envelope
 * `svg` names, so a server picture never serializes the scene on this side.
 * A refusal's scene, which this side builds, is drawn here in that envelope.
 */
export function layoutSpatialCanvasPicture(
  canvas: SpatialCanvas,
  options: SpatialLayoutOptions,
  svg: CoreSvgAsk,
): PicturedScene {
  return pictureThroughCore(canvas, options, svg)
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
  return layoutThroughCore(stored, options)
}

/**
 * The extent a node's content occupies when NOTHING is trimmed to fit it.
 *
 * This is the question an auto-fit asks — "how big does this box have to be"
 * — and it is deliberately a named function rather than a layout option or a
 * degenerate-height trick: a layout cannot tell that probe apart from a node
 * someone really made 1px tall. A node that needs `h` of content is contained
 * by a height of `h + 2 * geometry.paddingPx`.
 *
 * Chrome is excluded (it spans the stored box by definition), and so is a
 * label placed ABOVE the frame — that is not content in the box.
 */
export function naturalNodeContentSize(
  node: SpatialNode,
  options: Pick<SpatialLayoutOptions, 'measure' | 'appearance' | 'core'> &
    Partial<Pick<SpatialLayoutOptions, 'style' | 'fontAvailable' | 'fragments'>>,
): { readonly w: number; readonly h: number } {
  return naturalSizeThroughCore(node, options)
}

/**
 * The edge-and-label suffix of `layoutSpatialCanvas`'s scene, on its own:
 * routing, line jumps and centered labels through the core's own code path,
 * laying out no node content, for a consumer holding the node layer that
 * needs ONLY the edges re-laid against moved nodes (the editor's live drag
 * overlay); a second edge pipeline would drift from the committed result.
 */
export function layoutSpatialEdges(
  stored: SpatialCanvas,
  options: SpatialLayoutOptions,
): SceneNode[] {
  return edgesThroughCore(stored, options)
}

export type {
  SpatialContentCache,
  SpatialLayoutDegradation,
  SpatialLayoutOptions,
  SpatialRenderStyle,
} from './layout-options.js'

export { spatialRenderStyleSchema } from './layout-options.js'
