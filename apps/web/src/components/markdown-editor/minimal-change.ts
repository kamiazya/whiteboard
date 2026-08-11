/** A single replaced range: `doc.slice(0, from) + insert + doc.slice(to)`. */
export interface MinimalChange {
  readonly from: number
  readonly to: number
  readonly insert: string
}

/**
 * The smallest single-range edit turning `current` into `next`, found by
 * trimming the shared prefix and the shared suffix.
 *
 * The point is not brevity — it is that CodeMirror maps the selection
 * through whatever range a change touches. A whole-document replace claims
 * to touch everything, so every caret and selection inside it collapses to
 * a boundary; a change confined to the bytes that actually differ leaves
 * every position outside it exactly where the user put it.
 *
 * Offsets are UTF-16 code units, matching CodeMirror's own positions. A
 * boundary can therefore land between the halves of a surrogate pair (two
 * different emoji share a leading unit), which is harmless: the range is
 * still replaced wholesale, so the result is `next` either way — that is
 * what this module's round-trip property pins.
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
