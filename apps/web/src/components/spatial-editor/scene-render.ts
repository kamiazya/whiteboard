/**
 * `SpatialCanvas` -> `Scene` -> SVG string, via canvas-render's single
 * `layoutSpatialCanvas` builder — this is NOT a fourth scene builder; it is
 * a thin composition of `layoutSpatialCanvas` + `sceneBounds` +
 * `renderSceneToSvg`, exactly as `CanvasViewer` does in canvas-viewer.
 */
import { parseMarkdownBody } from '@kamiazya/whiteboard-canvas-codec'
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import type { BoundingBox, MeasureText, Scene } from '@kamiazya/whiteboard-canvas-render'
import {
  layoutSpatialCanvas,
  renderSceneToSvg,
  sceneBounds,
} from '@kamiazya/whiteboard-canvas-render'
import { EDITOR_APPEARANCE } from './editor-appearance.js'

export interface RenderCanvasOptions {
  readonly measure: MeasureText
}

export interface RenderedCanvas {
  readonly svg: string
  readonly bounds: BoundingBox
  readonly scene: Scene
}

export function renderCanvasToSvg(
  canvas: SpatialCanvas,
  options: RenderCanvasOptions,
): RenderedCanvas {
  const scene = layoutSpatialCanvas(canvas, {
    measure: options.measure,
    parseBody: parseMarkdownBody,
    appearance: EDITOR_APPEARANCE,
  })
  const bounds = sceneBounds(scene)
  const svg = renderSceneToSvg(scene, {
    width: bounds.w,
    height: bounds.h,
    viewBox: bounds,
  })
  return { svg, bounds, scene }
}
