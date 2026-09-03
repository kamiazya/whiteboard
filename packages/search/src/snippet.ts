/**
 * How much text either side of the match an excerpt carries, in UTF-16 code
 * units. Exported so a test can place a character exactly on the cut boundary
 * — duplicating the number there would let the generator silently stop
 * aiming at anything the day this changes.
 */
export const CONTEXT_RADIUS = 60

/**
 * A short plain-text excerpt around [index, index+length), whitespace
 * collapsed, ellipsised at cut edges. Shared by reference extraction and
 * search results so "where is this in the document" reads the same way
 * from both surfaces.
 */
export function snippetAround(value: string, index: number, length: number): string {
  // Snapped to whole characters before slicing. `slice` indexes UTF-16 code
  // UNITS, and everything outside the BMP — emoji, the rarer CJK ideographs —
  // is two of them, so a radius landing between the halves used to emit a lone
  // surrogate: a broken glyph at the edge of the excerpt, in every search
  // result and backlink context for that document.
  //
  // Inward, so an excerpt can never grow past the radius it was asked for and
  // the rule reads the same at both ends. This buys WHOLE CHARACTERS and not
  // whole graphemes: a combining mark or a flag sequence can still be split,
  // which needs `Intl.Segmenter` and is a larger question than the one
  // measured here.
  const start = snapForward(value, Math.max(0, index - CONTEXT_RADIUS))
  const end = snapBack(value, Math.min(value.length, index + length + CONTEXT_RADIUS))
  const text = value.slice(start, end).replace(/\s+/g, ' ').trim()
  return `${start > 0 ? '…' : ''}${text}${end < value.length ? '…' : ''}`
}

/** Past the low half of a pair, when the cut landed between the two. */
function snapForward(value: string, at: number): number {
  const unit = value.charCodeAt(at)
  return unit >= 0xdc00 && unit <= 0xdfff ? at + 1 : at
}

/** Before the high half of a pair, when the cut landed between the two. */
function snapBack(value: string, at: number): number {
  const unit = value.charCodeAt(at - 1)
  return unit >= 0xd800 && unit <= 0xdbff ? at - 1 : at
}
