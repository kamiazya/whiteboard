/**
 * `SpatialCanvas` -> `Scene` -> SVG string, via canvas-render's single
 * `layoutSpatialCanvas` builder — this is NOT a fourth scene builder; it is
 * a thin composition of `layoutSpatialCanvas` + `sceneBounds` +
 * `renderSceneToSvg`, exactly as `CanvasViewer` does in canvas-viewer.
 */
import { parseMarkdownBody } from '@kamiazya/whiteboard-canvas-codec'
import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-canvas-model'
import type { MdastRoot } from '@kamiazya/whiteboard-canvas-model/mdast'
import type { FacetCardData, MeasureText } from '@kamiazya/whiteboard-canvas-render'
import {
  layoutSpatialCanvas,
  SPATIAL_THEME_GEOMETRY,
  sceneBounds,
} from '@kamiazya/whiteboard-canvas-render'
import type { ResolvedTheme } from '../../hooks/useThemeMode.js'
import { createEditorAppearance } from './editor-appearance.js'
import { type RenderedCanvas, renderCanvasToSvgWith } from './scene-render-core.js'

export type { RenderedCanvas } from './scene-render-core.js'

export interface RenderCanvasOptions {
  readonly measure: MeasureText
  /** Defaults to 'light' so existing call sites render the pre-existing chrome unchanged. */
  readonly theme?: ResolvedTheme
  /** Passed through to layout: opaque file references become readable labels. */
  readonly resolveFileLabel?: (file: string) => string | undefined
  /** Passed through to layout: dangling references render a quiet missing state. */
  readonly resolveFileMissing?: (file: string) => boolean
  /** Passed through to layout: referenced canvas content for inline embeds. */
  readonly resolveFileCanvas?: (file: string) => SpatialCanvas | undefined
  /** Passed through to layout: a referenced markdown document's parsed body. */
  readonly resolveFileMarkdown?: (file: string) => MdastRoot | undefined
  /** Passed through to layout: the LOD gate deciding card vs miniature. */
  readonly expandFileNode?: (node: Extract<SpatialNode, { type: 'file' }>) => boolean
  /** Passed through to layout: image content for media file nodes. */
  readonly resolveFileImage?: (
    file: string,
  ) => { readonly href: string; readonly alt?: string } | undefined
  /** Passed through to layout: the referenced document's facets as card content. */
  readonly resolveFileFacets?: (file: string) => FacetCardData | undefined
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
  return renderCanvasToSvgWith(canvas, { ...options, parseBody: parseMarkdownBody })
}
