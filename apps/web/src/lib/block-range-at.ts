/**
 * The block of prose a caret is sitting in, as an offset range.
 *
 * What it is for: opening a conversation without first selecting anything.
 * Selecting a passage on a phone is a drag between two handles, which is the
 * most awkward gesture the platform has — and the reader who wants to say
 * something about a paragraph has already put the caret in it. So the
 * annotation entry falls back to this, and the thread quotes the paragraph
 * rather than a hand-dragged fragment of it.
 *
 * A BLOCK here is a run of non-blank lines, which is markdown's own
 * paragraph rule and needs no parse: a blank line separates blocks, and a
 * heading or a list item is a block whether or not the parser would call it
 * a paragraph. Deliberately not the mdast node — the anchor is a text quote
 * over the SOURCE, so a source-level range is the thing the quote is cut
 * from, and going through the parser would mean mapping positions back.
 *
 * Answers null on a blank line and in a whitespace-only body: there is no
 * prose there to be about, and `textAnchorForSelection` would refuse the
 * empty quote anyway. Letting the caller see the null is what keeps its
 * "nothing to comment on" branch honest.
 */
export interface BlockRange {
  readonly from: number
  readonly to: number
}

export function blockRangeAt(body: string, offset: number): BlockRange | null {
  const at = Math.max(0, Math.min(offset, body.length))
  // A caret at the very end of a line belongs to the line it ends, not to
  // the next one — `lastIndexOf` from `at` would otherwise walk past the
  // newline the caret sits before. Scanning outward from the caret's own
  // line start is what makes both edges read the same block.
  const lineStart = body.lastIndexOf('\n', at - 1) + 1
  const lineEndIndex = body.indexOf('\n', at)
  const lineEnd = lineEndIndex === -1 ? body.length : lineEndIndex
  if (body.slice(lineStart, lineEnd).trim() === '') return null

  let from = lineStart
  while (from > 0) {
    const previousEnd = from - 1
    const previousStart = body.lastIndexOf('\n', previousEnd - 1) + 1
    if (body.slice(previousStart, previousEnd).trim() === '') break
    from = previousStart
  }

  let to = lineEnd
  while (to < body.length) {
    const nextStart = to + 1
    const nextEndIndex = body.indexOf('\n', nextStart)
    const nextEnd = nextEndIndex === -1 ? body.length : nextEndIndex
    if (body.slice(nextStart, nextEnd).trim() === '') break
    to = nextEnd
  }
  return { from, to }
}

/**
 * The same block, but never null while the body holds any prose: a caret on
 * a blank line takes the nearest block, looking back before forward.
 *
 * This is what the annotation entries actually call, and the fallback is not
 * a nicety. A control's enabled state has to be derived from something that
 * re-renders it, and a CARET is not: it moves on a tap with no text change,
 * so a "no block here" disabled state would be stale exactly when a reader
 * had just moved onto a blank line. Choosing the neighbour removes the case
 * instead of racing it, and looking BACK first is what a reader means by
 * "here" — the blank line under a paragraph belongs to the paragraph above.
 *
 * Null only for a body with no prose at all, which IS derivable from the
 * value the editor already re-renders on.
 */
export function blockRangeNear(body: string, offset: number): BlockRange | null {
  const here = blockRangeAt(body, offset)
  if (here !== null) return here
  const at = Math.max(0, Math.min(offset, body.length))
  for (let back = at - 1; back >= 0; back--) {
    const found = blockRangeAt(body, back)
    if (found !== null) return found
  }
  for (let forward = at + 1; forward <= body.length; forward++) {
    const found = blockRangeAt(body, forward)
    if (found !== null) return found
  }
  return null
}
