/**
 * Turning a reader's selection into the anchor a thread is stored with.
 *
 * `resolveTextAnchor` is the reader; this is the writer, and the two are one
 * contract. What matters is not that this produces *an* anchor but that it
 * produces one the reader can still find after the body has been edited by
 * someone else, possibly on another machine — so the quote's SURROUNDINGS
 * are as load-bearing as the quote.
 */
import type { TextAnchor } from './text-anchor.js'

/**
 * How much text on each side is stored as context.
 *
 * MEASURED, not chosen. A throwaway harness re-anchored 4000 edited bodies
 * that contain the passage twice, with the edit sized to make the stored
 * offset point at the WRONG occurrence, and counted how often each candidate
 * length still landed on the right one:
 *
 *     0 chars   0.0%      16 chars  50.2%
 *     4 chars  42.0%      32 chars  50.2%
 *     8 chars  50.0%     128 chars  50.2%
 *
 * Two things follow, and neither was obvious before measuring. Context is
 * what does the work at all — with none, distance decides and is wrong every
 * time. And it SATURATES at 16: 32 and 128 recover not one additional case,
 * so a longer context is pure stored bytes.
 *
 * The 50% ceiling is the harness, not the algorithm: half its edits destroy
 * the text on BOTH sides of the passage, which no context length can survive.
 * What context buys is the other half, where one side is still intact — see
 * the "one side survives" case in the test beside this file.
 *
 * One named constant because both sides must agree, and a second literal is
 * how they stop agreeing.
 */
export const ANCHOR_CONTEXT_CHARS = 16

export function textAnchorForSelection(body: string, from: number, to: number): TextAnchor | null {
  const start = Math.max(0, Math.min(from, to))
  const end = Math.min(body.length, Math.max(from, to))
  const exact = body.slice(start, end)
  // A quote of nothing, or of only whitespace, re-anchors onto any gap in the
  // document — and `textQuoteSelectorSchema` rejects the empty one outright.
  // Refusing here is what lets the caller keep its "nothing to comment on"
  // branch honest instead of storing an anchor that means nothing.
  if (exact.trim() === '') return null

  const prefix = body.slice(Math.max(0, start - ANCHOR_CONTEXT_CHARS), start)
  const suffix = body.slice(end, end + ANCHOR_CONTEXT_CHARS)
  return {
    kind: 'text',
    quote: {
      exact,
      // Omitted rather than empty at a document edge: an empty string is
      // evidence that matches every candidate equally, so it adds a tie to
      // the scoring where absence adds nothing at all.
      ...(prefix === '' ? {} : { prefix }),
      ...(suffix === '' ? {} : { suffix }),
    },
    start,
    end,
  }
}
