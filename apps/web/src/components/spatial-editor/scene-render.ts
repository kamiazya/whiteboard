/**
 * `SpatialCanvas` -> `Scene` -> SVG string, via canvas-render's single
 * `layoutSpatialCanvas` builder — this is NOT a fourth scene builder; it is
 * a thin composition of `layoutSpatialCanvas` + `sceneBounds` +
 * `renderSceneToSvg`, exactly as `CanvasViewer` does in canvas-viewer.
 */
import { parseMarkdownBody } from '@kamiazya/whiteboard-canvas-codec'
import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-canvas-model'
import type { BoundingBox, MeasureText, Scene } from '@kamiazya/whiteboard-canvas-render'
import {
  layoutSpatialCanvas,
  renderSceneToSvg,
  SPATIAL_THEME_GEOMETRY,
  sceneBounds,
} from '@kamiazya/whiteboard-canvas-render'
import type { ResolvedTheme } from '../../hooks/useThemeMode.js'
import { createEditorAppearance } from './editor-appearance.js'

export interface RenderCanvasOptions {
  readonly measure: MeasureText
  /** Defaults to 'light' so existing call sites render the pre-existing chrome unchanged. */
  readonly theme?: ResolvedTheme
  /** Passed through to layout: opaque file references become readable labels. */
  readonly resolveFileLabel?: (file: string) => string | undefined
}

export interface RenderedCanvas {
  readonly svg: string
  readonly bounds: BoundingBox
  readonly scene: Scene
}

/**
 * The height a text node needs for its laid-out body, in canvas px.
 *
 * Measured by laying out the node ALONE with height 1: the shape chrome
 * always spans the stored height, so measuring at the real height could
 * never report "content is shorter than the box" — collapsing the box to
 * 1px makes the scene's bottom edge the CONTENT's bottom edge. Bottom
 * padding is added back so a grown box keeps the same breathing room the
 * layout gives the top.
 */
export function requiredTextNodeHeight(node: SpatialNode, options: RenderCanvasOptions): number {
  const probe: SpatialCanvas = { nodes: [{ ...node, height: 1 }], edges: [] }
  const scene = layoutSpatialCanvas(probe, {
    measure: options.measure,
    parseBody: parseMarkdownBody,
    appearance: createEditorAppearance(options.theme ?? 'light'),
  })
  const bounds = sceneBounds(scene)
  return bounds.y + bounds.h - node.y + SPATIAL_THEME_GEOMETRY.paddingPx
}

export function renderCanvasToSvg(
  canvas: SpatialCanvas,
  options: RenderCanvasOptions,
): RenderedCanvas {
  const scene = layoutSpatialCanvas(canvas, {
    measure: options.measure,
    parseBody: parseMarkdownBody,
    appearance: createEditorAppearance(options.theme ?? 'light'),
    resolveFileLabel: options.resolveFileLabel,
  })
  const bounds = sceneBounds(scene)
  const svg = renderSceneToSvg(scene, {
    width: bounds.w,
    height: bounds.h,
    viewBox: bounds,
  })
  return { svg, bounds, scene }
}
