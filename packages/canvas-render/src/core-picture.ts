import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { BoundingBox, Scene } from '@kamiazya/whiteboard-scene'
import type { CoreSvgAsk } from './canvas-core.js'
import { canvasThroughCore } from './layout/canvas-switch.js'
import type { SpatialLayoutOptions } from './layout/layout-options.js'
import { type MarkdownDocumentOptions, noteThroughCore } from './layout/markdown-switch.js'
import { sceneDocumentBounds } from './scene-bounds.js'
import { renderSceneToSvg, type SvgDocumentOptions } from './svg/backend.js'

// A server picture in one core call (ADR-0054 A2): the layout's request
// carries the envelope its SVG is drawn in, and the core answers the SVG
// beside the scene, drawn by its own backend. What the core does not draw is
// a refusal, whose scene this side builds (`refusalScene`), so this side
// draws that one, in the same envelope.

/** A laid-out scene and its SVG. */
export interface PicturedScene {
  readonly scene: Scene
  readonly svg: string
}

const EMPTY: BoundingBox = { x: 0, y: 0, w: 0, h: 0 }

/**
 * `ask` as `renderSceneToSvg`'s options over `scene`: the envelope the core
 * draws the same scene in, its `'document'` view box resolved against the
 * scene (an empty box for a scene with no node, which the bounds would answer
 * with their 1x1 fallback).
 */
function svgDocumentOptionsOf(ask: CoreSvgAsk, scene: Scene): SvgDocumentOptions {
  const { viewBox, padding, background, textFill, rasterScale } = ask
  const box = scene.nodes.length === 0 ? EMPTY : sceneDocumentBounds(scene)
  return {
    ...(viewBox === undefined ? {} : { viewBox: box }),
    ...(padding === undefined ? {} : { padding }),
    ...(background === undefined ? {} : { background }),
    ...(textFill === undefined ? {} : { textFill }),
    ...(rasterScale === undefined ? {} : { rasterScale }),
  }
}

/** The SVG the core drew, or a refusal's drawn here in the same envelope. */
function pictured(laid: { readonly scene: Scene; readonly svg?: string }, ask: CoreSvgAsk) {
  const svg = laid.svg ?? renderSceneToSvg(laid.scene, svgDocumentOptionsOf(ask, laid.scene))
  return { scene: laid.scene, svg }
}

/**
 * `layoutSpatialCanvas`'s scene with its SVG, both from ONE core call: the
 * core draws the scene it laid out with its own SVG backend, in the envelope
 * `svg` names, so a server picture never serializes the scene on this side.
 */
export function layoutSpatialCanvasPicture(
  canvas: SpatialCanvas,
  options: SpatialLayoutOptions,
  svg: CoreSvgAsk,
): PicturedScene {
  return pictured(canvasThroughCore(canvas, options, svg), svg)
}

/**
 * `layoutMarkdownDocument`'s scene with its SVG, both from ONE core call;
 * `undefined` for a `section` the note holds no heading for.
 */
export function layoutMarkdownDocumentPicture(
  body: string,
  options: MarkdownDocumentOptions,
  svg: CoreSvgAsk,
): PicturedScene | undefined {
  const laid = noteThroughCore(body, options, svg)
  return laid === undefined ? undefined : pictured(laid, svg)
}
