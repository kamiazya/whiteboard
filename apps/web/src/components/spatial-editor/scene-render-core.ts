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
import type { CommentThread, SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
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
  /**
   * The node whose text a DOM editor overlay owns right now, threaded to
   * canvas-render so the scene draws its chrome (silhouette included) and
   * not its body — what lets the overlay be transparent instead of an
   * opaque rectangle erasing a shaped node for the whole edit.
   */
  readonly suppressedBodyNodeIds?: readonly string[]
  /**
   * Boxes a comment bubble must not cover, beyond the rendered canvas's own
   * nodes and earlier bubbles (canvas-render's `commentObstacles`). The drag
   * layers render a comment APART from its canvas and still need it placed
   * exactly where the committed scene placed it, or the press jumps it.
   */
  readonly commentObstacles?: readonly BoundingBox[]
  /**
   * Draw resolved comments too, muted (canvas-render's `showResolved`).
   * Per-user VIEW state — it threads through every render of this surface
   * (committed, worker, drag layers) and is never written to the document.
   */
  readonly showResolved?: boolean
  /**
   * The document's conversations, for the passages inside text nodes
   * (canvas-render's `threads`): a highlight behind the quoted words. Pins
   * still come from the canvas's own projection, which is what the
   * optimistic state holds.
   */
  readonly threads?: readonly CommentThread[]
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
    suppressedBodyNodeIds: options.suppressedBodyNodeIds,
    commentObstacles: options.commentObstacles,
    showResolved: options.showResolved,
    threads: options.threads,
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
/**
 * The keyed render with every group under `keyPrefix` left out — how a
 * comment being dragged leaves the committed surface for the gesture. It
 * has to LEAVE rather than hide: the patcher animates a replaced group from
 * where it was (FLIP), so a hidden group that is replaced on the drop
 * commit flies from the old anchor to the new one, while a group that is
 * absent and then inserted never animates — the same reason the node drag
 * backdrop excludes the carried node. The `svg` string is rebuilt so the
 * producer's `svg === rootOpen + groups + close` pin still holds.
 */
export function keyedWithoutPrefix(keyed: KeyedSvgRender, keyPrefix: string): KeyedSvgRender {
  const groups = keyed.groups.filter((group) => !group.key.startsWith(keyPrefix))
  if (groups.length === keyed.groups.length) return keyed
  return {
    ...keyed,
    groups,
    svg: `${keyed.rootOpen}${groups.map((group) => group.svg).join('')}</svg>`,
  }
}

export function renderedCanvasKeyed(
  rendered: Pick<RenderedCanvas, 'scene' | 'bounds'>,
): KeyedSvgRender {
  return renderSceneToKeyedSvg(rendered.scene, documentEnvelope(rendered.bounds))
}
