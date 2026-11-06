// How long the text is that a map VALUE carries — a node, an edge, a line,
// a message are each one value — measured the way every reader reads it, for
// the sync judge's value bounds.

/** A node value's text: its resource's inline content, which is what every reader shows. */
export function nodeTextLength(value: unknown): number {
  if (typeof value !== 'object' || value === null) return 0
  return fieldLength((value as { resource?: unknown }).resource, 'content')
}

/**
 * A node value's longest location as every reader follows it: the resource's
 * `location` or `subpath`, or a group's `background` — an image location
 * every reader of image references follows.
 */
export function nodeLocationLength(value: unknown): number {
  if (typeof value !== 'object' || value === null) return 0
  const resource = (value as { resource?: unknown }).resource
  return Math.max(
    fieldLength(resource, 'location'),
    fieldLength(resource, 'subpath'),
    fieldLength(value, 'background'),
  )
}

/** The length of a value's string field, 0 when it has none. */
export function fieldLength(value: unknown, field: string): number {
  if (typeof value !== 'object' || value === null) return 0
  const held = (value as Record<string, unknown>)[field]
  return typeof held === 'string' ? held.length : 0
}

/**
 * The tags a map value carries: a node's or edge's own `tags` field, or —
 * for the board, whose tags are one value under their own key — the value
 * itself.
 */
export function tagsIn(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value
  if (typeof value !== 'object' || value === null) return []
  const held = (value as { tags?: unknown }).tags
  return Array.isArray(held) ? held : []
}

export function longestTag(value: unknown): number {
  let longest = 0
  for (const tag of tagsIn(value)) {
    if (typeof tag === 'string' && tag.length > longest) longest = tag.length
  }
  return longest
}

/**
 * How many nodes a thread's stored anchor names as a node set, 0 when it
 * names none: the count every layout pays one lookup each for.
 */
export function anchorNodeIdCount(value: unknown): number {
  if (typeof value !== 'object' || value === null) return 0
  const held = (value as { nodeIds?: unknown }).nodeIds
  return Array.isArray(held) ? held.length : 0
}

/** The length of a text anchor's quoted passage, 0 when `anchor` quotes none. */
function quoteLength(anchor: unknown): number {
  if (typeof anchor !== 'object' || anchor === null) return 0
  return fieldLength((anchor as { quote?: unknown }).quote, 'exact')
}

/** How long a thread's stored anchor's quote is: what every reader of the body re-finds. */
export function threadAnchorQuoteLength(value: unknown): number {
  return quoteLength(value)
}

/** How long a proposed change's anchor's quote is, 0 for a change with no text anchor. */
export function changeAnchorQuoteLength(value: unknown): number {
  if (typeof value !== 'object' || value === null) return 0
  return quoteLength((value as { anchor?: unknown }).anchor)
}
