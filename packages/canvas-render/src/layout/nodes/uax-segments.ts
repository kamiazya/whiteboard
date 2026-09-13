import { LineBreaker } from 'css-line-break'

/**
 * Break opportunities per UAX #14 with CSS `line-break: strict` — the same
 * algorithm a browser applies to `<p>`, which is where Japanese kinsoku
 * lives: a closing character never starts a line and an opening character
 * never ends one, and between two CJK ideographs almost anywhere is a break.
 * Each returned segment carries its own trailing whitespace.
 *
 * `wordBreak: 'normal'` is deliberate: `break-all` would also break English
 * mid-word, and an over-wide segment is handled where it arises (by finer
 * segments, then by code point) rather than by loosening the rule for every
 * string.
 *
 * Its own module because it has TWO readers — the wrapper's granularity
 * ladder in `mdast-blocks.ts` and the junction rule in `inline-junction.ts`
 * — and one producer of "where may a line break" is what stops the two
 * disagreeing about it. Nothing else here may call `LineBreaker` directly.
 */
export function uaxSegments(text: string): readonly string[] {
  const breaker = LineBreaker(text, { lineBreak: 'strict', wordBreak: 'normal' })
  const segments: string[] = []
  for (let entry = breaker.next(); entry.done !== true; entry = breaker.next()) {
    segments.push(entry.value.slice())
  }
  return segments
}
