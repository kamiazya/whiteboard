import type { MdastPhrasingContent } from '@kamiazya/whiteboard-model/mdast'
import type { EmbedResolvedNode, ShapeSceneNode, TextRunNode } from '@kamiazya/whiteboard-scene'
import { clampAdvance } from '../../measure.js'
import type { EmbeddedDocument } from '../../references/resolved.js'
import {
  baselineIn,
  bodyFont,
  bodyLineHeightPx,
  type Cursor,
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

/** The muted line under a pending embed's name. */
function loadingNotice(options: ResolvedMdastOptions, x: number, y: number): TextRunNode {
  const lineHeight = bodyLineHeightPx(options.theme)
  const metrics = options.measure(
    LOADING_NOTICE,
    bodyFont(options.fontFamily, options.theme.bodyFontSizePx),
  )
  return {
    kind: 'textRun',
    bbox: { x, y, w: clampAdvance(metrics.advanceWidth), h: lineHeight },
    baseline: clampAdvance(baselineIn(lineHeight, options.theme.bodyFontSizePx, metrics.ascent)),
    text: LOADING_NOTICE,
    appearance: {
      fill: options.theme.chromeColor,
      fontFamily: options.fontFamily,
      fontSize: options.theme.bodyFontSizePx,
    },
  }
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
  const notice = loadingNotice(options, startX + pad, startY + pad + titleHeight)
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
