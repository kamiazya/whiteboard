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
  KeyedSvgRender,
  MeasureText,
  ResolvedReference,
  Scene,
  SpatialContentCache,
  SvgDocumentOptions,
} from '@kamiazya/whiteboard-canvas-render'
import {
  layoutSpatialCanvasWithAnchors,
  renderSceneToKeyedSvg,
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
  /**
   * canvas-render's text-node body memo (see SpatialContentCache's caller
   * contract: one cache per measure+theme, dropped when either changes).
   * Never crosses to the layout worker — the worker keeps its own per-theme
   * cache, sound because it refuses to lay out before its font is loaded,
   * so its measurer is stable for its whole serving lifetime.
   */
  readonly contentCache?: SpatialContentCache
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
    contentCache: options.contentCache,
  })
  const bounds = sceneBounds(scene)
  const svg = renderSceneToSvg(scene, documentEnvelope(bounds))
  return { svg, bounds, scene, anchors }
}

/** The ONE producer of the editor surface's document-envelope options, so
 * the plain string and the keyed projection below can never disagree. */
function documentEnvelope(bounds: BoundingBox): SvgDocumentOptions {
  return { width: bounds.w, height: bounds.h, viewBox: bounds }
}

/**
 * The keyed projection of an already-rendered canvas, derived on the main
 * thread from the scene the worker (or sync path) already delivered —
 * stringification is ~3ms at 40 nodes against a 66-125ms layout, so the
 * worker protocol stays untouched. Same envelope as `RenderedCanvas.svg`.
 */
export function renderedCanvasKeyed(
  rendered: Pick<RenderedCanvas, 'scene' | 'bounds'>,
): KeyedSvgRender {
  return renderSceneToKeyedSvg(rendered.scene, documentEnvelope(rendered.bounds))
}
