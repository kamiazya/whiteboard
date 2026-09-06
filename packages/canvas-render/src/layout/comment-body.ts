/**
 * The ONE producer of a comment's prose, wherever a surface draws it.
 *
 * A comment's body is MARKDOWN. That was already true of the bubble on the
 * canvas — `layoutSpatialCanvas` has always sent it through the same mdast
 * pipeline a text node's body takes — and it was true of nothing else: the
 * web app's card and rail printed the same string raw, so `**tighten**`
 * read as emphasis on the canvas, in an export and in the widget, and as
 * four asterisks in the rail beside it. Nothing was red, because no surface
 * had ever been asked to agree with another about this.
 *
 * What this function fixes, so a second surface cannot pick differently:
 *
 * - **The metrics.** `MdastLayoutOptions.theme` defaults to the NODE theme
 *   and the bubble takes that default, but the obvious way to lay markdown
 *   out in apps/web is its preview renderer, which passes the DOCUMENT
 *   theme — a 30px h1 against the bubble's 24px, and a 16px block gap
 *   against 12px. A surface reaching for "the markdown renderer" would have
 *   got document typography by reflex and read as correct.
 * - **The measure.** `COMMENT_TEXT_MAX_WIDTH_PX` is the width a comment's
 *   prose wraps to when the surface has no opinion. A surface with one — a
 *   rail wider than a bubble — passes its own, and everything else about
 *   the layout still agrees.
 * - **The degradation.** `parseBody` ends in a Zod parse and can throw on a
 *   body being typed, so a comment that will not parse has to keep drawing
 *   something. It degrades to one run rather than aborting the layout that
 *   holds it.
 */

import { parseMarkdownBody } from '@kamiazya/whiteboard-codec'
import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import type { Scene } from '../scene-graph.js'
import { layoutMdastBlocks, type MdastLayoutOptions } from './nodes/mdast-blocks.js'

/**
 * The width a comment's prose is measured to when its surface names none.
 *
 * Narrow on purpose: a bubble floats over the canvas it annotates, and one
 * that grows with its text covers the thing being talked about.
 */
export const COMMENT_TEXT_MAX_WIDTH_PX = 200

/**
 * What a comment body's layout needs beyond an ordinary body's.
 *
 * `theme` is absent rather than optional — the point of this function is
 * that a comment's metrics are not a per-surface choice.
 */
export interface CommentBodyLayoutOptions extends Omit<MdastLayoutOptions, 'theme' | 'maxWidth'> {
  /** markdown -> mdast. Defaults to codec's parser, like every body layout. */
  readonly parseBody?: (text: string) => MdastRoot
  /** Defaults to `COMMENT_TEXT_MAX_WIDTH_PX`. */
  readonly maxWidth?: number
  /**
   * Told when the body would not parse, so a host with a logger can say so.
   * The layout degrades either way — an unreported degradation is still a
   * drawn comment, and a reported one still draws.
   */
  readonly onParseFailure?: (err: unknown) => void
}

/** The literal body, as the one paragraph a failed parse falls back to. */
function literalRoot(text: string): MdastRoot {
  return {
    type: 'root',
    children: [{ type: 'paragraph', children: [{ type: 'text', value: text }] }],
  }
}

export function layoutCommentBody(text: string, options: CommentBodyLayoutOptions): Scene {
  const { parseBody, maxWidth, onParseFailure, ...rest } = options
  const mdast: MdastLayoutOptions = { ...rest, maxWidth: maxWidth ?? COMMENT_TEXT_MAX_WIDTH_PX }
  let root: MdastRoot
  try {
    root = parseBody === undefined ? parseMarkdownBody(text) : parseBody(text)
  } catch (err) {
    onParseFailure?.(err)
    root = literalRoot(text)
  }
  try {
    return layoutMdastBlocks(root, mdast)
  } catch (err) {
    // A tree that parses and will not lay out is the same failure to a
    // reader: the comment still has to be on screen.
    onParseFailure?.(err)
    return layoutMdastBlocks(literalRoot(text), mdast)
  }
}
