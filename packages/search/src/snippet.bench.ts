// The cost of one search result's excerpts. `full-text.ts` calls
// `snippetAround` up to three times per matching document, each on the whole
// searchable text with the hit somewhere inside it, so the body here is
// document-sized and the hits are interior — the shape the function meets in
// production, not a short string with the needle at the front.
//
// Run with `pnpm vitest bench --project search-node --run`.
//
// **The pair is the measurement, not either row.** `ascii` cannot hold a
// grapheme cluster at all, so it is the floor of what the function costs
// with nothing to segment; `emoji` and `cjk` are the bodies where a
// grapheme-aware cut has work to do. The DIFFERENCE is that work's price.
// A single row drifts 2-3x with machine load; compare before/after on the
// same machine, interleaved, in one sitting.
import { bench, describe } from 'vitest'
import { snippetAround } from './snippet.js'

const NEEDLE = 'needle'
const HITS = 3

/** A body with the needle planted at three interior offsets, like a real match. */
function bodyOf(filler: string, length: number): { text: string; indexes: number[] } {
  const chunk = filler.repeat(Math.ceil(length / 3 / filler.length))
  const text = `${chunk} ${NEEDLE} ${chunk} ${NEEDLE} ${chunk} ${NEEDLE} ${chunk}`
  const indexes: number[] = []
  for (let at = text.indexOf(NEEDLE); at !== -1; at = text.indexOf(NEEDLE, at + 1)) {
    indexes.push(at)
  }
  return { text, indexes: indexes.slice(0, HITS) }
}

const ASCII = bodyOf('lorem ipsum dolor sit amet consectetur ', 6000)
const EMOJI = bodyOf('review 👨‍👩‍👧‍👦 shipped 🇯🇵 done 👍🏽 next 1️⃣ ', 6000)
const CJK = bodyOf('設計レビューを終えて次の段階に進む。', 6000)

function excerpts(body: { text: string; indexes: number[] }): number {
  let total = 0
  for (const index of body.indexes) total += snippetAround(body.text, index, NEEDLE.length).length
  return total
}

describe('snippetAround, three excerpts of a document-sized body', () => {
  bench('ascii body', () => {
    excerpts(ASCII)
  })
  bench('emoji-bearing body', () => {
    excerpts(EMOJI)
  })
  bench('cjk body', () => {
    excerpts(CJK)
  })
})
