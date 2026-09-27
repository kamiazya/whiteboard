import type { LoroText } from 'loro-crdt'

/** A single replaced range: `current.slice(0, from) + insert + current.slice(to)`. */
export interface MinimalChange {
  readonly from: number
  readonly to: number
  readonly insert: string
}

/**
 * The smallest single-range edit turning `current` into `next`, found by
 * trimming the shared prefix and the shared suffix.
 *
 * What this buys, in a CRDT, is everything. A whole-document replace deletes
 * every character and re-inserts it, so the operation log grows by the whole
 * document and the update sent to every peer IS the whole document — for one
 * keystroke. Measured on a 12,348-character body over 40 single-character
 * saves: 501,816 bytes on the wire and +25,322 in the snapshot, against
 * 3,517 and +133 for the same edits spliced.
 *
 * It is also what lets anything ANCHOR into the text. A rich-text mark
 * belongs to the characters it covers, so a write that removes every
 * character removes every mark — which is how the annotation layer's
 * passages would vanish on the next save.
 *
 * Offsets are UTF-16 code units, matching both Loro's text indices and
 * CodeMirror's positions. The span is widened to whole code points: two
 * different emoji share a leading unit ('😀' and '😁' both start \uD83D), so
 * the trimmed span would otherwise start between a surrogate pair's halves —
 * and Loro refuses that outright ("Cannot insert or delete utf-16 in the
 * middle of the codepoint"), failing the whole write.
 */
export function minimalChange(current: string, next: string): MinimalChange {
  const shorter = Math.min(current.length, next.length)

  let from = 0
  while (from < shorter && current[from] === next[from]) from++
  // The shared prefix is shared, so a leading half here precedes the
  // trailing half in BOTH strings; step back over it.
  if (from > 0 && isHighSurrogate(current.charCodeAt(from - 1))) from--

  let to = current.length
  let end = next.length
  while (to > from && end > from && current[to - 1] === next[end - 1]) {
    to--
    end--
  }
  // Likewise a trailing half at the start of the shared suffix belongs to
  // the code point the span ends inside; take it into the span.
  if (to < current.length && isLowSurrogate(current.charCodeAt(to))) {
    to++
    end++
  }

  return { from, to, insert: next.slice(from, end) }
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff
}

/**
 * Writes `next` into `text` as the one span that differs, and says whether
 * anything changed. Every writer that turns a plain string back into a live
 * text goes through here, so none of them can fall back to a whole-text
 * replace — which takes every mark on the text down with it.
 */
export function spliceText(text: LoroText, next: string): boolean {
  const change = minimalChange(text.toString(), next)
  if (change.to === change.from && change.insert.length === 0) return false
  if (change.to > change.from) text.delete(change.from, change.to - change.from)
  if (change.insert.length > 0) text.insert(change.from, change.insert)
  return true
}
