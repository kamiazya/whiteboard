// A canvas node's text, held where a person writes it to the bound the agent
// tools already hold it to. Laying a node's text out costs its keeper time
// linear in the length on every render, so a node past `NODE_TEXT_MAX_CHARS`
// is never made here — not typed or pasted into the node editor, nor
// pasted onto the canvas as a new node, nor copied from a node written
// before the bound. A copy is held to the keeper's other canvas bounds here
// too — a node's location, an element's label and its tags — for the same
// reason.
import type { Extension } from '@codemirror/state'
import {
  type ClipboardFragment,
  LABEL_MAX_CHARS,
  NODE_LOCATION_MAX_CHARS,
  NODE_TEXT_MAX_CHARS,
  nodeText,
  nodeUrl,
  type SpatialNode,
  TAG_MAX_CHARS,
  TAGS_PER_ELEMENT_MAX,
} from '@kamiazya/whiteboard-model'
import {
  type CopyVerb,
  copiedLabelNotice,
  copiedLocationNotice,
  copiedNodeTextNotice,
  copiedTagsNotice,
  type LocationPart,
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

/** What a paste or duplicate writes: the copied elements, and a cut's severed edges. */
export type CopiedFragment = Pick<ClipboardFragment, 'nodes' | 'edges' | 'lines' | 'cut'>

/** The longest of `items` by `length`, or undefined when there are none. */
function longestOf<T extends { readonly length: number }>(items: readonly T[]): T | undefined {
  return items.reduce<T | undefined>(
    (most, item) => (most === undefined || item.length > most.length ? item : most),
    undefined,
  )
}

/** Each part of a node's location with its length, read as the keeper reads them. */
function locationParts(node: SpatialNode): { part: LocationPart; length: number }[] {
  const { location, subpath } = node.resource ?? {}
  return [
    { part: nodeUrl(node) === undefined ? 'path' : 'URL', length: location?.length ?? 0 },
    { part: 'subpath', length: subpath?.length ?? 0 },
  ]
}

/**
 * Why a paste or duplicate making these nodes and edges would breach a tag
 * bound, or null when every element's tags fit. Stored tags are read
 * leniently, so a copy can carry tags written past either bound.
 */
function copiedTagsRefusal(
  tagged: readonly { readonly tags?: readonly string[] }[],
  verb: CopyVerb,
): string | null {
  const lists = tagged.map((element) => element.tags ?? [])
  const most = longestOf(lists)
  if (most !== undefined && most.length > TAGS_PER_ELEMENT_MAX) {
    return copiedTagsNotice(verb, 'count', most.length)
  }
  const tag = longestOf(lists.flat())
  if (tag !== undefined && tag.length > TAG_MAX_CHARS) {
    return copiedTagsNotice(verb, 'chars', tag.length)
  }
  return null
}

/**
 * Why a paste or duplicate of this fragment makes nothing, or null when all
 * of it fits. Judged against every bound the keeper holds a canvas write to —
 * a node's text, a link's URL or a file's path or subpath, an edge's, line's
 * or frame's label, and a node's or edge's tags, their count and the longest —
 * since a copy past any of them would be drawn here and then refused by the
 * keeper, and vanish again.
 *
 * An element written before a bound still reads and still takes an edit that
 * shortens it, but a copy is a new element, and the bound is on making one.
 * Refused whole: dropping only the long element would cut the relations that
 * end on it out of the copy. A cut's severed edges count too, because a paste
 * that reconnects them writes them again.
 */
export function copiedFragmentRefusal(fragment: CopiedFragment, verb: CopyVerb): string | null {
  const { nodes } = fragment
  const text = longestOf(nodes.map((node) => nodeText(node) ?? ''))
  if (text !== undefined && text.length > NODE_TEXT_MAX_CHARS) {
    return copiedNodeTextNotice(verb, text.length)
  }
  const location = longestOf(nodes.flatMap(locationParts))
  if (location !== undefined && location.length > NODE_LOCATION_MAX_CHARS) {
    return copiedLocationNotice(verb, location.part, location.length)
  }
  const edges = [...fragment.edges, ...(fragment.cut?.boundaryEdges ?? [])]
  const labelled = [...nodes, ...edges, ...(fragment.lines ?? [])]
  const label = longestOf(labelled.map((element) => element.label ?? ''))
  if (label !== undefined && label.length > LABEL_MAX_CHARS) {
    return copiedLabelNotice(verb, label.length)
  }
  // A line carries no tags: ink makes no claim to classify.
  return copiedTagsRefusal([...nodes, ...edges], verb)
}
