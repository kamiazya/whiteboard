/**
 * The `SpatialCanvas` -> `Scene` -> SVG composition.
 *
 * Split out of scene-render.ts so the layout worker can import this without
 * the editor-side module graph hanging off scene-render.ts. This is NOT a
 * second scene builder: scene-render.ts calls straight through to here, so
 * there is still exactly one composition of `layoutSpatialCanvas` +
 * `sceneBounds` + `renderSceneToSvg`.
 *
 * It used to take a `parseBody` too, so that a static codec import stayed out
 * of the worker chunk. canvas-render now DEFAULTS to codec's parser, and the
 * worker imported codec directly anyway, so the option was one more copy of
 * the same line rather than a boundary.
 */

import type {
  BoundingBox,
  EdgeAnchorPair,
  MeasureText,
  ResolvedReference,
  Scene,
} from '@kamiazya/whiteboard-canvas-render'
import {
  layoutSpatialCanvasWithAnchors,
  renderSceneToSvg,
  sceneBounds,
} from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import type { ResolvedTheme } from '../../hooks/useThemeMode.js'
import { createEditorAppearance } from './editor-appearance.js'

export interface RenderCanvasCoreOptions {
  readonly measure: MeasureText
  readonly theme?: ResolvedTheme
  readonly resolveReference?: (ref: string) => ResolvedReference | undefined
  readonly expandFileNode?: (node: Extract<SpatialNode, { type: 'file' }>) => boolean
}

export interface RenderedCanvas {
  readonly svg: string
  readonly bounds: BoundingBox
  readonly scene: Scene
  /**
   * The edge-anchor map the layout routed with. Carried out so a consumer
   * that needs the committed anchors (the drag overlay pins bystander edges
   * to them) never re-runs the anchor pass — it is the most expensive step
   * of the layout, and it already ran to produce this scene.
   */
  readonly anchors: ReadonlyMap<string, EdgeAnchorPair>
}

export function renderCanvasToSvgWith(
  canvas: SpatialCanvas,
  options: RenderCanvasCoreOptions,
): RenderedCanvas {
  const { scene, anchors } = layoutSpatialCanvasWithAnchors(canvas, {
    measure: options.measure,
    appearance: createEditorAppearance(options.theme ?? 'light'),
    resolveReference: options.resolveReference,
    expandFileNode: options.expandFileNode,
  })
  const bounds = sceneBounds(scene)
  const svg = renderSceneToSvg(scene, { width: bounds.w, height: bounds.h, viewBox: bounds })
  return { svg, bounds, scene, anchors }
}
