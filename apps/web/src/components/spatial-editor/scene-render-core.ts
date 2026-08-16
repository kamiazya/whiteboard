/**
 * The `SpatialCanvas` -> `Scene` -> SVG composition, with NO markdown parser
 * of its own.
 *
 * Split out of scene-render.ts so the layout worker can import it: that module
 * supplies codec's `parseMarkdownBody` as the default, and a static
 * import of the codec drags remark and unified into whatever imports it —
 * a worker chunk that has no use for them, and (under the dev server) cannot
 * even evaluate them. This is NOT a second scene builder: scene-render.ts
 * calls straight through to here, so there is still exactly one composition
 * of `layoutSpatialCanvas` + `sceneBounds` + `renderSceneToSvg`.
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
import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import type { ResolvedTheme } from '../../hooks/useThemeMode.js'
import { createEditorAppearance } from './editor-appearance.js'

export interface RenderCanvasCoreOptions {
  readonly measure: MeasureText
  /** Required here; scene-render.ts is where the codec default is applied. */
  readonly parseBody: (text: string) => MdastRoot
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
    parseBody: options.parseBody,
    appearance: createEditorAppearance(options.theme ?? 'light'),
    resolveReference: options.resolveReference,
    expandFileNode: options.expandFileNode,
  })
  const bounds = sceneBounds(scene)
  const svg = renderSceneToSvg(scene, { width: bounds.w, height: bounds.h, viewBox: bounds })
  return { svg, bounds, scene, anchors }
}
