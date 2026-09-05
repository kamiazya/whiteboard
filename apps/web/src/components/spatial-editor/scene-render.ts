/**
 * `SpatialCanvas` -> `Scene` -> SVG string, via canvas-render's single
 * `layoutSpatialCanvas` builder — this is NOT a fourth scene builder; it is
 * a thin composition of `layoutSpatialCanvas` + `sceneBounds` +
 * `renderSceneToSvg`, exactly as `CanvasViewer` does in canvas-viewer.
 */

import type {
  BoundingBox,
  MeasureText,
  ResolvedReference,
} from '@kamiazya/whiteboard-canvas-render'
import { naturalNodeContentSize, SPATIAL_THEME_GEOMETRY } from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import type { ResolvedTheme } from '../../lib/theme.js'
import { createEditorAppearance } from './editor-appearance.js'
import { type RenderedCanvas, renderCanvasToSvgWith } from './scene-render-core.js'

export type { RenderedCanvas } from './scene-render-core.js'

export interface RenderCanvasOptions {
  readonly measure: MeasureText
  /** Defaults to 'light' so existing call sites render the pre-existing chrome unchanged. */
  readonly theme?: ResolvedTheme
  /** Passed through to layout: what the host resolved for one reference. */
  readonly resolveReference?: (ref: string) => ResolvedReference | undefined
  /** Passed through to layout: the LOD gate deciding card vs miniature. */
  readonly expandFileNode?: (node: Extract<SpatialNode, { type: 'file' }>) => boolean
  /** See RenderCanvasCoreOptions: the node ids whose body an editor overlay owns. */
  readonly suppressedBodyNodeIds?: readonly string[]
  /** See RenderCanvasCoreOptions: boxes a comment bubble must not cover. */
  readonly commentObstacles?: readonly BoundingBox[]
  /** See RenderCanvasCoreOptions: draw resolved comments (muted) too. */
  readonly showResolved?: boolean
}

/**
 * The height a text node needs for its laid-out body, in canvas px.
 *
 * `naturalNodeContentSize` is canvas-render's own answer to "how big must
 * this box be", so this is padding arithmetic and nothing else. It used to
 * lay the node out at height 1 and read the scene's bottom edge, which
 * worked only because a box that small cannot bound anything — layout could
 * not tell this probe apart from a node someone really made 1px tall, so
 * the escape hatch it needed stayed open for every tiny node as well.
 */
export function requiredTextNodeHeight(node: SpatialNode, options: RenderCanvasOptions): number {
  const content = naturalNodeContentSize(node, {
    measure: options.measure,
    appearance: createEditorAppearance(options.theme ?? 'light'),
  })
  return content.h + 2 * SPATIAL_THEME_GEOMETRY.paddingPx
}

export function renderCanvasToSvg(
  canvas: SpatialCanvas,
  options: RenderCanvasOptions,
): RenderedCanvas {
  return renderCanvasToSvgWith(canvas, options)
}
