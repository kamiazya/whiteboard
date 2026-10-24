import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { MdastPhrasingContent } from '@kamiazya/whiteboard-model/mdast'
import type {
  EmbedResolvedNode,
  SceneNode,
  ShapeSceneNode,
  TextRunNode,
} from '@kamiazya/whiteboard-scene'
import { clampAdvance } from '../../measure.js'
import type { EmbeddedDocument } from '../../references/resolved.js'
import {
  baselineIn,
  bodyFont,
  bodyLineHeightPx,
  type Cursor,
  type EmbeddedCanvasBox,
  type EmbeddedCanvasMiniature,
  type PhrasingLayout,
  panelPaint,
  type ResolvedMdastOptions,
} from './mdast-layout-options.js'

/** `resolveTitle` guarded to the never-throw rule. */
export function tryResolveTitle(
  options: ResolvedMdastOptions,
  documentId: string,
): string | undefined {
  try {
    return options.resolveTitle?.(documentId)
  } catch {
    return undefined
  }
}

/** `resolveEmbed` guarded to the never-throw rule. */
export function tryResolveEmbed(
  options: ResolvedMdastOptions,
  documentId: string,
): EmbeddedDocument | undefined {
  try {
    return options.resolveEmbed?.(documentId)
  } catch {
    return undefined
  }
}

/** `isEmbedPending` guarded to the never-throw rule. */
export function tryIsEmbedPending(options: ResolvedMdastOptions, documentId: string): boolean {
  try {
    return options.isEmbedPending?.(documentId) === true
  } catch {
    return false
  }
}

/**
 * The name an embed is labelled with: the loaded document's own, else — for a
 * target still loading, which has no content to name it yet — the keeper's
 * list, else the id. An answered-with-nothing target keeps showing its id.
 */
export function embedTitle(options: ResolvedMdastOptions, documentId: string): string {
  return (
    tryResolveEmbed(options, documentId)?.title ??
    (tryIsEmbedPending(options, documentId) ? tryResolveTitle(options, documentId) : undefined) ??
    documentId
  )
}

const LOADING_NOTICE = 'Loading…'
const EMPTY_CANVAS_NOTICE = 'Empty canvas'

/** A muted line of chrome under an embed's name — never a link. */
function embedNotice(
  options: ResolvedMdastOptions,
  text: string,
  x: number,
  y: number,
): TextRunNode {
  const lineHeight = bodyLineHeightPx(options.theme)
  const metrics = options.measure(text, bodyFont(options.fontFamily, options.theme.bodyFontSizePx))
  return {
    kind: 'textRun',
    bbox: { x, y, w: clampAdvance(metrics.advanceWidth), h: lineHeight },
    baseline: clampAdvance(baselineIn(lineHeight, options.theme.bodyFontSizePx, metrics.ascent)),
    text,
    appearance: {
      fill: options.theme.chromeColor,
      fontFamily: options.fontFamily,
      fontSize: options.theme.bodyFontSizePx,
    },
  }
}

/**
 * What a canvas embed's panel holds under its name, and where that ends. A
 * canvas with nothing on it says so: a bare panel under a link reads as a
 * preview that failed to draw. One that could not be fitted leaves the panel
 * at the title's height; the second pad is the gap above a miniature, so it
 * is only paid for one.
 */
export function canvasEmbedBody(
  canvas: SpatialCanvas,
  miniature: EmbeddedCanvasMiniature | undefined,
  box: EmbeddedCanvasBox,
  titleBottom: number,
  options: ResolvedMdastOptions,
): { readonly nodes: readonly SceneNode[]; readonly bottom: number } {
  if (canvas.nodes.length === 0 && canvas.edges.length === 0 && (canvas.lines ?? []).length === 0) {
    const notice = embedNotice(options, EMPTY_CANVAS_NOTICE, box.x, titleBottom)
    return { nodes: [notice], bottom: titleBottom + notice.bbox.h }
  }
  if (miniature === undefined) return { nodes: [], bottom: titleBottom }
  return { nodes: miniature.nodes, bottom: box.y + miniature.h }
}

/**
 * The block drawn for an embed whose target has been asked for and not yet
 * answered: the canvas embed's panel, the target's linked name along its top
 * and a muted loading line under it, so a slow load reads as in progress
 * rather than as a broken link. The frame is the chrome a resolved canvas
 * embed uses, so the swap to content does not shift the layout sideways.
 */
export function layoutPendingEmbed(
  options: ResolvedMdastOptions,
  documentId: string,
  fragment: string | undefined,
  cursor: Cursor,
  // The phrasing layout lives with the typesetter this module is imported by.
  layoutTitle: (
    nodes: readonly MdastPhrasingContent[],
    cursor: Cursor,
    options: ResolvedMdastOptions,
    fontSizePx: number,
  ) => PhrasingLayout,
): EmbedResolvedNode {
  const startX = cursor.x
  const startY = cursor.y
  const pad = options.theme.codeBlockPaddingPx
  cursor.x = startX + pad
  cursor.y = startY + pad
  const title = layoutTitle(
    [{ type: 'embed', documentId, ...(fragment === undefined ? {} : { fragment }) }],
    cursor,
    options,
    options.theme.bodyFontSizePx,
  )
  cursor.x = startX
  const lineHeight = bodyLineHeightPx(options.theme)
  const titleHeight = title.lineCount * lineHeight
  const notice = embedNotice(options, LOADING_NOTICE, startX + pad, startY + pad + titleHeight)
  const height = pad + titleHeight + lineHeight + pad
  const frame: ShapeSceneNode = {
    kind: 'shape',
    bbox: { x: startX, y: startY, w: options.maxWidth, h: height },
    radius: options.theme.cornerRadiusPx,
    appearance: panelPaint(options.theme, options.theme.panelOpacity),
  }
  cursor.y = startY + height + options.theme.blockGapPx
  return {
    kind: 'embedResolved',
    bbox: { x: startX, y: startY, w: options.maxWidth, h: height },
    documentId,
    children: [frame, ...title.runs, notice],
  }
}
