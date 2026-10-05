// A canvas node's text, held where a person writes it to the bound the agent
// tools already hold it to. Laying a node's text out costs its keeper time
// linear in the length on every render, so a node past `NODE_TEXT_MAX_CHARS`
// is never made here — not typed or pasted into the node editor, nor
// pasted onto the canvas as a new node, nor copied from a node written
// before the bound.
import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { NODE_TEXT_MAX_CHARS, nodeText, type SpatialNode } from '@kamiazya/whiteboard-model'
import { textLengthLimit } from '../../lib/text-length-limit.js'

const COUNT = new Intl.NumberFormat('en-US')

/**
 * The node editor's limit. The notice is short and set small because it
 * shares the node's own box with the text, which may be a few lines tall.
 */
export const nodeTextLengthLimit: Extension = [
  // FIRST, and that order is the override: CodeMirror mounts the earliest
  // theme last, so it wins over the limit's own document-sized notice.
  EditorView.theme({
    '.cm-length-limit-notice': { padding: '2px 4px', fontSize: '11px', lineHeight: '1.3' },
  }),
  textLengthLimit(
    NODE_TEXT_MAX_CHARS,
    (length) =>
      `Not added: the node would be ${COUNT.format(length)} characters, past its ${COUNT.format(NODE_TEXT_MAX_CHARS)}-character limit.`,
  ),
]

/**
 * Why plain text pasted onto the canvas makes no node, or null when it fits.
 *
 * Refused whole rather than split across several nodes: a cut at the bound
 * lands mid-sentence or inside a code fence, and the person would then have
 * to find and repair every seam — a document is where text that long belongs.
 */
export function pastedTextRefusal(text: string): string | null {
  if (text.length <= NODE_TEXT_MAX_CHARS) return null
  return `Not pasted: the text is ${COUNT.format(text.length)} characters, past the ${COUNT.format(NODE_TEXT_MAX_CHARS)}-character limit for one node. Put it in a markdown document, or paste it in parts.`
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
  return `Not ${verb}: a node's text is ${COUNT.format(longest)} characters, past the ${COUNT.format(NODE_TEXT_MAX_CHARS)}-character limit for one node. Shorten it first.`
}
