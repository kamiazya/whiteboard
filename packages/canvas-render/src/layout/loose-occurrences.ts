/**
 * Where a quote occurs in a text when every run of whitespace on either side
 * compares equal to any other — what a `word\s+word` regex finds, without
 * the regex's cost.
 *
 * The regex re-reads up to the whole quote at every start before failing, so
 * on a periodic text one search costs text x quote. Squashing both sides'
 * whitespace runs to one space turns the loose comparison into an exact one,
 * which the model's `textOccurrences` answers in bounded time; an index map
 * carries each squashed position back to the text.
 */
import { textOccurrences } from '@kamiazya/whiteboard-model'

export interface LooseSpan {
  readonly start: number
  readonly end: number
}

const WHITESPACE = /\s/

/**
 * The text with each whitespace run read as one space, and for each squashed
 * character the offset in `text` it came from — a run's first character.
 */
function squashWithOffsets(text: string): { squashed: string; offsets: Int32Array } {
  const offsets = new Int32Array(text.length)
  let squashed = ''
  let length = 0
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at] as string
    if (WHITESPACE.test(char)) {
      if (at > 0 && WHITESPACE.test(text[at - 1] as string)) continue
      squashed += ' '
    } else {
      squashed += char
    }
    offsets[length] = at
    length += 1
  }
  return { squashed, offsets: offsets.subarray(0, length) }
}

/**
 * Every non-overlapping occurrence of `quote`, leftmost first, as offsets into
 * `text`. A match starts at the quote's first non-blank character and ends
 * after its last, as the regex's did; leading and trailing whitespace in the
 * quote ask nothing of the text. A blank quote occurs nowhere.
 */
export function looseOccurrences(text: string, quote: string): LooseSpan[] {
  const needle = quote.trim().replace(/\s+/g, ' ')
  if (needle === '') return []
  const { squashed, offsets } = squashWithOffsets(text)
  // A cost shortcut, not a rule: the search would find nothing either, but
  // only after building a border table as long as a quote that cannot fit.
  if (needle.length > squashed.length) return []
  const spans: LooseSpan[] = []
  let free = 0
  for (const at of textOccurrences(squashed, needle)) {
    // The regex resumed after each match, so an overlapping one never counts.
    if (at < free) continue
    free = at + needle.length
    spans.push({
      start: offsets[at] as number,
      end: (offsets[free - 1] as number) + 1,
    })
  }
  return spans
}
