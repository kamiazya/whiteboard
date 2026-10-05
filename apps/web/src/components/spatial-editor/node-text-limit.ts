// A canvas node's text, held where a person writes it to the bound the agent
// tools already hold it to. Laying a node's text out costs its keeper time
// linear in the length on every render, so a node past `NODE_TEXT_MAX_CHARS`
// is never made here — not typed or pasted into the node editor, nor
// pasted onto the canvas as a new node, nor copied from a node written
// before the bound.
import type { Extension } from '@codemirror/state'
import { NODE_TEXT_MAX_CHARS, nodeText, type SpatialNode } from '@kamiazya/whiteboard-model'
import {
  copiedNodeTextNotice,
  nodeTextEditNotice,
  pastedTextNotice,
} from '../../lib/limit-notice.js'
import { textLengthLimit } from '../../lib/text-length-limit.js'

/**
 * The node editor's limit. The notice is set small because it shares the
 * node's own box with the text.
 */
export const nodeTextLengthLimit: Extension = textLengthLimit(
  NODE_TEXT_MAX_CHARS,
  nodeTextEditNotice,
  { compact: true },
)

/**
 * Why plain text pasted onto the canvas makes no node, or null when it fits.
 *
 * Refused whole rather than split across several nodes: a cut at the bound
 * lands mid-sentence or inside a code fence, and the person would then have
 * to find and repair every seam — a document is where text that long belongs.
 */
export function pastedTextRefusal(text: string): string | null {
  if (text.length <= NODE_TEXT_MAX_CHARS) return null
  return pastedTextNotice(text.length)
}

/**
 * Why a paste or duplicate of these nodes makes nothing, or null when every
 * one fits. A node written before the bound still reads and still takes an
 * edit that shortens it, but a copy is a new node, and the bound is on
 * making one. Refused whole: dropping only the long node would cut the
 * relations that end on it out of the copy.
 */
export function copiedTextRefusal(
  nodes: readonly SpatialNode[],
  verb: 'pasted' | 'duplicated',
): string | null {
  const longest = nodes.reduce((most, node) => Math.max(most, nodeText(node)?.length ?? 0), 0)
  if (longest <= NODE_TEXT_MAX_CHARS) return null
  return copiedNodeTextNotice(verb, longest)
}
