import type { BoundingBox, Scene } from '@kamiazya/whiteboard-scene'
import type { CoreSvgAsk } from '../canvas-core.js'
import { sceneDocumentBounds } from '../scene-bounds.js'
import { renderSceneToSvg, type SvgDocumentOptions } from '../svg/backend.js'

// A server picture in one core call (ADR-0054): the layout's request carries
// the envelope its SVG is drawn with, and the core answers the SVG beside the
// scene, drawn by its own backend. What the core does not draw is a refusal,
// whose scene this side builds (`refusalScene`), so this side draws it too.

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
export function svgDocumentOptionsOf(ask: CoreSvgAsk, scene: Scene): SvgDocumentOptions {
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

/** The SVG of a scene the core did not lay out (a refusal's), in the envelope `ask` names. */
export function svgOfDrawnHere(scene: Scene, ask: CoreSvgAsk): string {
  return renderSceneToSvg(scene, svgDocumentOptionsOf(ask, scene))
}

/** The core's SVG for a request that asked one; an answer without it is a defect in the core. */
export function askedSvg(svg: string | undefined): string {
  if (svg === undefined) throw new Error('the core answered no SVG for a layout that asked one')
  return svg
}
