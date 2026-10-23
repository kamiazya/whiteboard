/**
 * `SpatialCanvas` -> `Scene` -> SVG string, via canvas-render's single
 * `layoutSpatialCanvas` builder — this is NOT a fourth scene builder; it is
 * a thin composition of `layoutSpatialCanvas` + `sceneBounds` +
 * `renderSceneToSvg`, exactly as `CanvasViewer` does in canvas-viewer.
 */

import type {
  BoundingBox,
  MeasureText,
  ReferenceSeams,
  ResolvedReference,
  SpatialRenderStyle,
  SpatialThemeMode,
} from '@kamiazya/whiteboard-canvas-render'
import { naturalNodeContentSize, SPATIAL_THEME_GEOMETRY } from '@kamiazya/whiteboard-canvas-render'
import type { CommentThread, SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import type { TagLibrary } from '@kamiazya/whiteboard-plugin-visual'
import { createEditorAppearance } from './editor-appearance.js'
import { backgroundOf, type PictureExportOptions } from './picture-options.js'
import {
  type RenderCanvasCoreOptions,
  type RenderedCanvas,
  renderCanvasForExportWith,
  renderCanvasToSvgWith,
} from './scene-render-core.js'

export type { RenderedCanvas } from './scene-render-core.js'

export interface RenderCanvasOptions {
  readonly measure: MeasureText
  /** Defaults to 'light' so existing call sites render the pre-existing chrome unchanged. */
  readonly theme?: SpatialThemeMode
  /** See RenderCanvasCoreOptions: `'document'` unless a session overrides it. */
  readonly style?: SpatialRenderStyle
  /** Passed through to layout: the reference bundle text-node bodies read. */
  readonly references?: ReferenceSeams
  /** Passed through to layout: what the host resolved for one reference. */
  readonly resolveReference?: (ref: string) => ResolvedReference | undefined
  /** Passed through to layout: the LOD gate deciding card vs miniature. */
  readonly expandFileNode?: (node: SpatialNode) => boolean
  /** See RenderCanvasCoreOptions: the node ids whose body an editor overlay owns. */
  readonly suppressedBodyNodeIds?: readonly string[]
  /** See RenderCanvasCoreOptions: the node ids that wear a padlock. */
  readonly lockedNodeIds?: readonly string[]
  /** See RenderCanvasCoreOptions: boxes a comment bubble must not cover. */
  readonly commentObstacles?: readonly BoundingBox[]
  /** See RenderCanvasCoreOptions: draw resolved comments (muted) too. */
  readonly showResolved?: boolean
  /** See RenderCanvasCoreOptions: the fragment seams every body is typeset through. */
  readonly renderMath?: NonNullable<RenderCanvasCoreOptions['renderMath']>
  readonly renderDiagram?: NonNullable<RenderCanvasCoreOptions['renderDiagram']>
}

/**
 * The height a text node needs for its laid-out body, in canvas px.
 *
 * `naturalNodeContentSize` is canvas-render's own answer to "how big must
 * this box be", so this is padding arithmetic and nothing else. Laying the
 * node out at height 1 and reading the scene's bottom edge would work only
 * because a box that small cannot bound anything — layout could not tell
 * that probe apart from a node someone really made 1px tall, so the escape
 * hatch it needed would stay open for every tiny node as well.
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

/** What a saved picture of a canvas is drawn with beside the canvas itself. */
export interface CanvasExportOptions {
  readonly measure: MeasureText
  /** The bundle the editor resolves file nodes, embeds and pictures through. */
  readonly references?: ReferenceSeams
  /** The canvas's conversations, for the passage highlights the editor draws. */
  readonly threads?: readonly CommentThread[]
  /** The workspace's colour by intent (ADR-0040 decision 5), part of the picture. */
  readonly tagLibrary?: TagLibrary
  /**
   * Draw the annotation layer (pins, cards, highlights) into the picture.
   * Absent is off: unlike the editor, a saved file is for someone else.
   */
  readonly comments?: boolean
  /** Absent is a transparent 1x picture. */
  readonly picture?: PictureExportOptions
  /** See RenderCanvasCoreOptions: the fragment seams every body is typeset through. */
  readonly renderMath?: NonNullable<RenderCanvasCoreOptions['renderMath']>
  readonly renderDiagram?: NonNullable<RenderCanvasCoreOptions['renderDiagram']>
}

/**
 * The saved document: the editor's layout, with its legend in its band.
 *
 * Pinned to the light theme: a saved artifact's bytes must never depend on a
 * display preference. Every file node is drawn in full, by intrinsic size:
 * the editor's on-screen gate depends on a zoom a saved file does not have,
 * and this is the policy the daemon's export takes. Synchronous like every
 * layout: the caller that can wait for math and diagrams runs it through
 * `layoutWithFragments` (`lib/fragment-requests.ts`) and hands the seams in.
 */
export function renderCanvasForExport(
  canvas: SpatialCanvas,
  {
    measure,
    references,
    threads,
    tagLibrary,
    comments,
    picture,
    renderMath,
    renderDiagram,
  }: CanvasExportOptions,
): { readonly svg: string; readonly bounds: BoundingBox; readonly scale?: number } {
  const drawn = renderCanvasForExportWith(
    canvas,
    {
      measure,
      theme: 'light',
      commentLayer: comments === true,
      ...(references === undefined ? {} : { references, expandFileNode: () => true }),
      ...(threads === undefined ? {} : { threads }),
      ...(tagLibrary === undefined ? {} : { tagLibrary }),
      renderMath,
      renderDiagram,
    },
    backgroundOf(picture),
  )
  return picture === undefined ? drawn : { ...drawn, scale: picture.scale }
}
