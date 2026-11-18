import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { BoundingBox, Scene, SceneNode } from '@kamiazya/whiteboard-scene'
import type { CoreKeyedSvg, CoreSvgAsk } from './canvas-core.js'
import type { EdgeAnchorPair } from './edge-routing.js'
import { canvasThroughCore, type MaybePictured } from './layout/canvas-switch.js'
import type { SpatialLayoutOptions } from './layout/layout-options.js'
import {
  type CommentDocumentOptions,
  commentThroughCore,
  type MarkdownDocumentOptions,
  noteThroughCore,
} from './layout/markdown-switch.js'
import { edgeLayerThroughCore } from './layout/query-switch.js'
import { sceneBounds, sceneDocumentBounds } from './scene-bounds.js'
import { renderSceneToSvg, type SvgDocumentOptions } from './svg/backend.js'
import { renderSceneToKeyedSvg } from './svg/keyed.js'
import { stripXmlInvalidChars } from './xml-escape.js'

// A picture in one core call (ADR-0054 A2, A3): the layout's request carries
// the envelope its SVG is drawn in, and the core answers the SVG (or its keyed
// projection) beside the scene, drawn by its own backend. What the core does
// not draw is a refusal, whose scene this side builds (`refusalScene`), so
// this side draws that one, in the same envelope and form.

/** A laid-out scene and its SVG. */
export interface PicturedScene {
  readonly scene: Scene
  readonly svg: string
}

/** A laid-out scene and its keyed projection. */
export interface KeyedPicture {
  readonly scene: Scene
  readonly keyed: CoreKeyedSvg
}

/** The envelope a picture is asked in; its form is the function's to name. */
type CorePictureAsk = Omit<CoreSvgAsk, 'form'>

const EMPTY: BoundingBox = { x: 0, y: 0, w: 0, h: 0 }

/** The view box `ask` names, resolved against `scene` as the core resolves it. */
function viewBoxOf(viewBox: NonNullable<CoreSvgAsk['viewBox']>, scene: Scene): BoundingBox {
  if (viewBox === 'document') return scene.nodes.length === 0 ? EMPTY : sceneDocumentBounds(scene)
  if (viewBox.of === 'document') return sceneDocumentBounds(scene, viewBox.margin)
  const bounds = sceneBounds(scene)
  const margin = viewBox.margin ?? 0
  if (!Number.isFinite(margin) || margin <= 0) return bounds
  return {
    x: bounds.x - margin,
    y: bounds.y - margin,
    w: bounds.w + margin * 2,
    h: bounds.h + margin * 2,
  }
}

/**
 * `ask` as `renderSceneToSvg`'s options over `scene`: the envelope the core
 * draws the same scene in, its view box resolved against the scene.
 */
function svgDocumentOptionsOf(ask: CoreSvgAsk, scene: Scene): SvgDocumentOptions {
  const { viewBox, width, height, padding, background, textFill, rasterScale, legend } = ask
  return {
    ...(viewBox === undefined ? {} : { viewBox: viewBoxOf(viewBox, scene) }),
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
    ...(padding === undefined ? {} : { padding }),
    ...(background === undefined ? {} : { background }),
    ...(textFill === undefined ? {} : { textFill }),
    ...(rasterScale === undefined ? {} : { rasterScale }),
    ...(legend === undefined ? {} : { legend }),
  }
}

/** What a layout through the core answered: its scene, and the picture the core drew of it, if any. */
type Laid = { readonly scene: Scene } & MaybePictured

/**
 * The SVG the core drew, or a refusal's drawn here in the same envelope. Only
 * a refusal carries no picture; one in the other form is a defect in the asking.
 */
function pictured(laid: Laid, ask: CorePictureAsk): PicturedScene {
  if (laid.keyed !== undefined) throw new Error('the core answered a keyed projection, not an SVG')
  const svg = laid.svg ?? renderSceneToSvg(laid.scene, svgDocumentOptionsOf(ask, laid.scene))
  return { scene: laid.scene, svg }
}

/** The keyed projection the core drew, or a refusal's drawn here; as `pictured`. */
function keyedPictured(laid: Laid, ask: CorePictureAsk): KeyedPicture {
  if (laid.svg !== undefined) throw new Error('the core answered an SVG, not a keyed projection')
  const keyed =
    laid.keyed ?? renderSceneToKeyedSvg(laid.scene, svgDocumentOptionsOf(ask, laid.scene))
  return { scene: laid.scene, keyed }
}

/**
 * The ask as the wire can carry it. A paint is a caller's string, and one
 * the core's wire refuses (a lone surrogate) would refuse the whole layout;
 * the serializer drops those characters from an attribute anyway, so
 * dropping them here first draws the same document.
 */
function wireAsk<A extends CorePictureAsk>(ask: A): A {
  const { background, textFill } = ask
  return {
    ...ask,
    ...(background === undefined ? {} : { background: stripXmlInvalidChars(background) }),
    ...(textFill === undefined ? {} : { textFill: stripXmlInvalidChars(textFill) }),
  }
}

const keyedAsk = (ask: CorePictureAsk): CoreSvgAsk => ({ ...wireAsk(ask), form: 'keyed' })

/**
 * `layoutSpatialCanvas`'s scene with its SVG, both from ONE core call: the
 * core draws the scene it laid out with its own SVG backend, in the envelope
 * `svg` names, so a picture never serializes the scene on this side.
 */
export function layoutSpatialCanvasPicture(
  canvas: SpatialCanvas,
  options: SpatialLayoutOptions,
  svg: CorePictureAsk,
): PicturedScene & { readonly anchors: ReadonlyMap<string, EdgeAnchorPair> } {
  const laid = canvasThroughCore(canvas, options, wireAsk(svg))
  return { ...pictured(laid, svg), anchors: laid.anchors }
}

/**
 * `layoutSpatialCanvasWithAnchors`'s scene and anchors with the keyed
 * projection of the scene, all from ONE core call, in the envelope `svg` names.
 */
export function layoutSpatialCanvasKeyedPicture(
  canvas: SpatialCanvas,
  options: SpatialLayoutOptions,
  svg: CorePictureAsk,
): KeyedPicture & { readonly anchors: ReadonlyMap<string, EdgeAnchorPair> } {
  const laid = canvasThroughCore(canvas, options, keyedAsk(svg))
  return { ...keyedPictured(laid, svg), anchors: laid.anchors }
}

/**
 * `layoutMarkdownDocument`'s scene with its SVG, both from ONE core call;
 * `undefined` for a `section` the note holds no heading for.
 */
export function layoutMarkdownDocumentPicture(
  body: string,
  options: MarkdownDocumentOptions,
  svg: CorePictureAsk,
): PicturedScene | undefined {
  const laid = noteThroughCore(body, options, wireAsk(svg))
  return laid === undefined ? undefined : pictured(laid, svg)
}

/** `layoutMarkdownDocumentPicture` answered as the keyed projection. */
export function layoutMarkdownDocumentKeyedPicture(
  body: string,
  options: MarkdownDocumentOptions,
  svg: CorePictureAsk,
): KeyedPicture | undefined {
  const laid = noteThroughCore(body, options, keyedAsk(svg))
  return laid === undefined ? undefined : keyedPictured(laid, svg)
}

/** `layoutCommentDocument`'s scene with its keyed projection, both from ONE core call. */
export function layoutCommentDocumentKeyedPicture(
  body: string,
  options: CommentDocumentOptions,
  svg: CorePictureAsk,
): KeyedPicture {
  return keyedPictured(commentThroughCore(body, options, keyedAsk(svg)), svg)
}

/**
 * `layoutSpatialEdges`'s edge layer with its SVG, both from ONE core call: the
 * layer drawn as a scene of its own (no legend) in the envelope `svg` names.
 * A layer the core refused is no edges, drawn here in the same envelope.
 */
export function layoutSpatialEdgesPicture(
  canvas: SpatialCanvas,
  options: SpatialLayoutOptions,
  svg: CorePictureAsk,
): { readonly nodes: SceneNode[]; readonly svg: string } {
  const { nodes, ...picture } = edgeLayerThroughCore(canvas, options, wireAsk(svg))
  const { svg: drawn } = pictured({ scene: { nodes }, ...picture }, svg)
  return { nodes, svg: drawn }
}
