/**
 * The `SpatialCanvas` -> `Scene` -> SVG composition.
 *
 * Split out of scene-render.ts so the layout worker can import this without
 * the editor-side module graph hanging off scene-render.ts. This is NOT a
 * second scene builder: scene-render.ts calls straight through to here, so
 * there is still exactly one composition of the layout and its picture, both
 * answered by the Rust core in one call (ADR-0054 A3): the core draws the
 * scene it laid out, in the envelope this module names.
 *
 * It takes no `parseBody`: canvas-render DEFAULTS to codec's parser, and the
 * worker imports codec directly anyway, so the option would be one more copy
 * of the same line rather than a boundary.
 */

import type {
  BoundingBox,
  CoreSvgAsk,
  EdgeAnchorPair,
  KeyedSvgRender,
  MeasureText,
  ReferenceSeams,
  Scene,
  SpatialContentCache,
  SpatialLayoutOptions,
  SpatialThemeMode,
} from '@kamiazya/whiteboard-canvas-render'
import {
  layoutSpatialCanvasKeyedPicture,
  layoutSpatialCanvasPicture,
  sceneBounds,
  sceneDocumentBounds,
} from '@kamiazya/whiteboard-canvas-render'
import { hasLoadedFace } from '@kamiazya/whiteboard-canvas-viewer/font-loading'
import type {
  CommentThread,
  Proposal,
  SpatialCanvas,
  SpatialNode,
} from '@kamiazya/whiteboard-model'
import type { TagLibrary } from '@kamiazya/whiteboard-plugin-visual'
import { createEditorAppearance } from './editor-appearance.js'
import { requireLayoutCore } from './require-layout-core.js'

export interface RenderCanvasCoreOptions {
  readonly measure: MeasureText
  readonly theme?: SpatialThemeMode
  /** The reference bundle, for what text-node bodies embed and link. */
  readonly references?: ReferenceSeams
  readonly expandFileNode?: (node: SpatialNode) => boolean
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
  /** Node ids that wear a padlock (canvas-render's `lockedNodeIds`). */
  readonly lockedNodeIds?: readonly string[]
  /**
   * Boxes a comment bubble must not cover, beyond the rendered canvas's own
   * nodes and earlier bubbles (canvas-render's `commentObstacles`). The drag
   * layers render a comment APART from its canvas and still need it placed
   * exactly where the committed scene placed it, or the press jumps it.
   */
  readonly commentObstacles?: readonly BoundingBox[]
  /**
   * The workspace's tag library (ADR-0040 decision 5), when the keeper
   * answered one: a box or an edge carrying a value it colours, and no
   * colour of its own, is drawn in that colour and the legend lists the
   * key — the picture the daemon's export and `wb_scene_render` draw.
   */
  readonly tagLibrary?: TagLibrary
  /**
   * Draw resolved comments too, muted (canvas-render's `showResolved`).
   * Per-user VIEW state — it threads through every render of this surface
   * (committed, worker, drag layers) and is never written to the document.
   */
  readonly showResolved?: boolean
  /** canvas-render's `commentLayer`; absent draws the annotation layer, as the editor needs. */
  readonly commentLayer?: boolean
  /**
   * The document's conversations (canvas-render's `threads`): every pin and
   * bubble, and a highlight behind the words a passage quotes. The canvas
   * carries none of them — the layer is a plane beside it.
   */
  readonly threads?: readonly CommentThread[]
  /**
   * This document's open proposals (ADR-0029 decision 1), drawn in place on
   * the live canvas: an outline where each change would land and one bubble
   * per proposal. Plain data, so it crosses to the layout worker unchanged.
   */
  readonly proposals?: readonly Proposal[]
  /**
   * What the layout could not do as asked (canvas-render's own seam,
   * threaded verbatim). The worker listens for `font-missing` so the thread
   * that owns the face set learns which family a board's theme names
   * without decoding the canvas itself.
   */
  readonly onDegrade?: SpatialLayoutOptions['onDegrade']
  /**
   * Typeset math blocks and diagram fences in every body the layout reaches,
   * from the fragments this realm has rendered (canvas-render's table, the
   * same data the Rust core answers from). A source the table lacks keeps
   * its fallback and is handed to `onFragmentsAsked`, once each per layout;
   * a host renders it ahead (`lib/fragment-requests.ts`) and lays out again.
   * Data rather than the `renderMath`/`renderDiagram` function seams, which
   * the core's request gate skips. Both absent, math keeps its source and a
   * fence is a plain code block.
   */
  readonly fragments?: SpatialLayoutOptions['fragments']
  readonly onFragmentsAsked?: SpatialLayoutOptions['onFragmentsAsked']
}

/** A laid-out canvas: its scene, the bounds it is drawn over, and its anchors. */
interface LaidOutCanvas {
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

/** A laid-out canvas with its SVG, as a list row or a drag layer draws it. */
export interface RenderedCanvas extends LaidOutCanvas {
  readonly svg: string
}

/**
 * A laid-out canvas with its keyed projection, as the editor surface patches
 * it in (`keyed-svg-patcher.ts`): the same envelope as `RenderedCanvas.svg`,
 * one group per key.
 */
export interface KeyedRenderedCanvas extends LaidOutCanvas {
  readonly keyed: KeyedSvgRender
}

/**
 * What every layout this editor runs shares — the look, its resolver, and
 * where a theme's family counts as available — in ONE place, so the edge
 * overlay a drag re-routes per frame cannot draw a different look from
 * the committed scene it floats over.
 */
export function editorLayoutBase(options: {
  readonly measure: MeasureText
  readonly theme?: SpatialThemeMode
}): Pick<SpatialLayoutOptions, 'measure' | 'appearance' | 'style' | 'fontAvailable' | 'core'> {
  return {
    measure: options.measure,
    appearance: createEditorAppearance(options.theme ?? 'light'),
    // ADR-0030 decision 6: every surface of this app pictures the theme
    // the document names — the editor, its drag layers, the thumbnail, the
    // preview and the export alike — fixed HERE, in the one composition the
    // worker and the main thread share, so the two cannot draw apart.
    style: 'document',
    // A theme's family is declared only where this realm holds a loaded
    // face for it; otherwise layout measures and declares the bundled one,
    // the same answer the daemon's export gives.
    fontAvailable: hasLoadedFace,
    // The Rust core this realm has loaded (ADR-0054), which the page and the
    // worker await before their first layout: every layout here takes the
    // same core, the worker's and the drag layers' alike, or the committed
    // scene and the overlay floating over it would route apart.
    core: requireLayoutCore(),
  }
}

/** `options` as the layout options every picture of the editor surface is laid out with. */
function surfaceLayoutOptions(options: RenderCanvasCoreOptions): SpatialLayoutOptions {
  return {
    ...editorLayoutBase(options),
    references: options.references,
    expandFileNode: options.expandFileNode,
    contentCache: options.contentCache,
    suppressedBodyNodeIds: options.suppressedBodyNodeIds,
    lockedNodeIds: options.lockedNodeIds,
    commentObstacles: options.commentObstacles,
    showResolved: options.showResolved,
    commentLayer: options.commentLayer,
    threads: options.threads,
    proposals: options.proposals,
    onDegrade: options.onDegrade,
    tagLibrary: options.tagLibrary,
    fragments: options.fragments,
    onFragmentsAsked: options.onFragmentsAsked,
  }
}

/**
 * The ONE envelope of the editor surface, so the plain picture and the keyed
 * projection can never disagree: the scene's own bounds, at their own size.
 * No legend: the keyed projection cannot carry one, and the editor draws it
 * as an overlay (ADR-0040 decision 6).
 */
const SURFACE_ASK = { viewBox: { of: 'scene' }, legend: 'omit' } as const satisfies CoreSvgAsk

export function renderCanvasToSvgWith(
  canvas: SpatialCanvas,
  options: RenderCanvasCoreOptions,
): RenderedCanvas {
  const { scene, anchors, svg } = layoutSpatialCanvasPicture(
    canvas,
    surfaceLayoutOptions(options),
    SURFACE_ASK,
  )
  return { svg, bounds: sceneBounds(scene), scene, anchors }
}

/** `renderCanvasToSvgWith` answered as the keyed projection, in the same envelope. */
export function renderCanvasKeyedWith(
  canvas: SpatialCanvas,
  options: RenderCanvasCoreOptions,
): KeyedRenderedCanvas {
  const { scene, anchors, keyed } = layoutSpatialCanvasKeyedPicture(
    canvas,
    surfaceLayoutOptions(options),
    SURFACE_ASK,
  )
  return { keyed, bounds: sceneBounds(scene), scene, anchors }
}

/**
 * The blank band a saved picture keeps around what it draws, the same on
 * every side. Without it a frame's stroke sat on the picture's last row.
 */
const EXPORT_MARGIN_PX = 16

/**
 * The document a person SAVES: the same layout as the editor surface, drawn
 * as a whole document with its legend (ADR-0040 decision 6) in the band
 * `sceneDocumentBounds` reserves for it — the editor surface's envelope omits
 * the legend, because the editor draws it as an overlay, so an export taken
 * from that picture would lose what the screen shows. `background` absent
 * leaves the picture transparent.
 */
export function renderCanvasForExportWith(
  canvas: SpatialCanvas,
  options: RenderCanvasCoreOptions,
  background?: string,
): { readonly svg: string; readonly bounds: BoundingBox } {
  const { scene, svg } = layoutSpatialCanvasPicture(canvas, surfaceLayoutOptions(options), {
    viewBox: { of: 'document', margin: EXPORT_MARGIN_PX },
    ...(background === undefined ? {} : { background }),
  })
  return { svg, bounds: sceneDocumentBounds(scene, EXPORT_MARGIN_PX) }
}

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
