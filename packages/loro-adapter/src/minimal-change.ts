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
 * CodeMirror's positions. A boundary can therefore land between the halves
 * of a surrogate pair (two different emoji share a leading unit), which is
 * harmless: the range is replaced wholesale, so the result is `next` either
 * way — that is what this module's round-trip property pins.
 */
export function minimalChange(current: string, next: string): MinimalChange {
  const shorter = Math.min(current.length, next.length)

  let from = 0
  while (from < shorter && current[from] === next[from]) from++

  let to = current.length
  let end = next.length
  while (to > from && end > from && current[to - 1] === next[end - 1]) {
    to--
    end--
  }

  return { from, to, insert: next.slice(from, end) }
}
