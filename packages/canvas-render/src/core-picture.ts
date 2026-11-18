import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { Scene, SceneNode } from '@kamiazya/whiteboard-scene'
import type { CoreKeyedSvg, CoreSvgAsk } from './canvas-core.js'
import type { EdgeAnchorPair } from './edge-routing.js'
import type { MaybePictured } from './layout/asked-picture.js'
import { canvasThroughCore } from './layout/canvas-switch.js'
import type { SpatialLayoutOptions } from './layout/layout-options.js'
import {
  type CommentDocumentOptions,
  commentThroughCore,
  type MarkdownDocumentOptions,
  noteThroughCore,
} from './layout/markdown-switch.js'
import { type NoticeOptions, type NoticeWords, noticeThroughCore } from './layout/notice-switch.js'
import { edgeLayerThroughCore } from './layout/query-switch.js'
import type { LayoutCore } from './layout-core.js'
import { stripXmlInvalidChars } from './xml-escape.js'

// A picture in one core call (ADR-0054 A2, A3): the layout's request carries
// the envelope its SVG is drawn in, and the core answers the SVG (or its keyed
// projection) beside the scene, drawn by its own backend. A refused layout is
// the core's notice, drawn the same way; only a realm with no core to answer
// even that is left without a picture, and answers an empty picture.

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

/**
 * The picture drawn where no core drew one: nothing, sized to nothing so it
 * takes no room where it lands. A realm with no core answers it for a refusal,
 * and the core answers no picture for an edge layer it refused.
 */
const NOTHING_OPEN = '<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0">'
const NOTHING_SVG = `${NOTHING_OPEN}</svg>`
const NOTHING_KEYED: CoreKeyedSvg = {
  svg: NOTHING_SVG,
  rootOpen: NOTHING_OPEN,
  rootAttrs: { xmlns: 'http://www.w3.org/2000/svg', width: '0', height: '0' },
  groups: [],
}

/** What a layout through the core answered: its scene, and the picture the core drew of it, if any. */
type Laid = { readonly scene: Scene } & MaybePictured

/**
 * The SVG the core drew; `NOTHING_SVG` where it drew none. A picture in the
 * other form is a defect in the asking.
 */
function pictured(laid: Laid): PicturedScene {
  if (laid.keyed !== undefined) throw new Error('the core answered a keyed projection, not an SVG')
  return { scene: laid.scene, svg: laid.svg ?? NOTHING_SVG }
}

/** The keyed projection the core drew; as `pictured`. */
function keyedPictured(laid: Laid): KeyedPicture {
  if (laid.svg !== undefined) throw new Error('the core answered an SVG, not a keyed projection')
  return { scene: laid.scene, keyed: laid.keyed ?? NOTHING_KEYED }
}

/**
 * The ask as the wire can carry it. A paint is a caller's string, and one
 * the core's wire refuses (a lone surrogate) would refuse the whole layout;
 * the serializer drops those characters from an attribute anyway, so
 * dropping them here first draws the same picture.
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
  return { ...pictured(laid), anchors: laid.anchors }
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
  return { ...keyedPictured(laid), anchors: laid.anchors }
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
  return laid === undefined ? undefined : pictured(laid)
}

/** `layoutMarkdownDocumentPicture` answered as the keyed projection. */
export function layoutMarkdownDocumentKeyedPicture(
  body: string,
  options: MarkdownDocumentOptions,
  svg: CorePictureAsk,
): KeyedPicture | undefined {
  const laid = noteThroughCore(body, options, keyedAsk(svg))
  return laid === undefined ? undefined : keyedPictured(laid)
}

/** `layoutCommentDocument`'s scene with its keyed projection, both from ONE core call. */
export function layoutCommentDocumentKeyedPicture(
  body: string,
  options: CommentDocumentOptions,
  svg: CorePictureAsk,
): KeyedPicture {
  return keyedPictured(commentThroughCore(body, options, keyedAsk(svg)))
}

/**
 * `layoutSpatialEdges`'s edge layer with its SVG, both from ONE core call: the
 * layer drawn as a scene of its own (no legend) in the envelope `svg` names.
 * A layer the core refused is no edges, and no picture.
 */
export function layoutSpatialEdgesPicture(
  canvas: SpatialCanvas,
  options: SpatialLayoutOptions,
  svg: CorePictureAsk,
): { readonly nodes: SceneNode[]; readonly svg: string } {
  const { nodes, ...picture } = edgeLayerThroughCore(canvas, options, wireAsk(svg))
  const { svg: drawn } = pictured({ scene: { nodes }, ...picture })
  return { nodes, svg: drawn }
}

/**
 * A refusal's notice, words and all, drawn by the core: one box and its text
 * runs, with its SVG, both
 * from ONE core call. The words stay `refusalCopy`'s, so every surface that
 * words a refusal says the same thing.
 */
export function layoutNoticePicture(
  core: LayoutCore,
  words: NoticeWords,
  options: NoticeOptions,
  svg: CorePictureAsk,
): PicturedScene {
  const { nodes, ...picture } = noticeThroughCore(core, words, options, wireAsk(svg))
  return pictured({ scene: { nodes }, ...picture })
}

/** `layoutNoticePicture` answered as the keyed projection. */
export function layoutNoticeKeyedPicture(
  core: LayoutCore,
  words: NoticeWords,
  options: NoticeOptions,
  svg: CorePictureAsk,
): KeyedPicture {
  const { nodes, ...picture } = noticeThroughCore(core, words, options, keyedAsk(svg))
  return keyedPictured({ scene: { nodes }, ...picture })
}
