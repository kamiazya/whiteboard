/**
 * `resolveTextAnchorAmong` is `resolveTextAnchor` for a caller that already
 * holds every occurrence of the quote: given them, it must place every anchor
 * exactly where the search would, orphan included.
 *
 * The two share the scoring of candidates; what differs is how the candidates
 * are chosen — an outward search stopping at the nearest
 * `SCORED_OCCURRENCES_MAX`, against a range cut from the full sorted list —
 * and the order they are scored in. That is what this compares, so the bodies
 * are dense in the quote: a two-letter alphabet, where most quotes occur many
 * times and many tie on context, and long periodic ones that reach the cut.
 */
import { expect } from 'vitest'
import type { TextAnchor } from './annotation.js'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'
import { resolveTextAnchor, resolveTextAnchorAmong, textOccurrences } from './text-anchor.js'

const dense = fc.stringMatching(/^[ab]{0,60}$/)
const quote = fc.stringMatching(/^[ab]{1,3}$/)
const context = fc.option(fc.stringMatching(/^[ab]{0,6}$/), { nil: undefined })

function anchorOf(
  exact: string,
  start: number,
  prefix: string | undefined,
  suffix: string | undefined,
): TextAnchor {
  return {
    kind: 'text',
    quote: {
      exact,
      ...(prefix === undefined ? {} : { prefix }),
      ...(suffix === undefined ? {} : { suffix }),
    },
    start,
    end: start + exact.length,
  }
}

const reached = { many: 0, missed: 0 }

fcTest.prop([dense, quote, fc.nat({ max: 70 }), context, context], withDefaults())(
  'places an anchor where the search would, given every occurrence',
  (body, exact, start, p, s) => {
    const anchor = anchorOf(exact, start, p, s)
    const occurrences = textOccurrences(body, exact)
    if (occurrences.length > 1) reached.many += 1
    if (body.slice(start, start + exact.length) !== exact) reached.missed += 1
    expect(resolveTextAnchorAmong(body, anchor, occurrences)).toEqual(
      resolveTextAnchor(body, anchor),
    )
  },
)

fcTest.prop(
  [fc.integer({ min: 1500, max: 6000 }), fc.nat({ max: 7000 }), fc.nat({ max: 7000 }), context],
  withDefaults({ numRuns: 30 }),
)('agrees past the scored-occurrence cut', (length, start, planted, s) => {
  // `aab` repeated: `a` occurs twice per period, more than the cut holds.
  // One occurrence somewhere carries the remembered prefix whole, so scoring
  // past the cut would prefer it wherever it lies.
  const periodic = 'aab'.repeat(Math.ceil(length / 3)).slice(0, length)
  const at = planted % (length + 1)
  const body = `${periodic.slice(0, at)}bbbb${periodic.slice(at)}`
  const anchor = anchorOf('a', start, 'bbbb', s)
  expect(resolveTextAnchorAmong(body, anchor, textOccurrences(body, 'a'))).toEqual(
    resolveTextAnchor(body, anchor),
  )
})

// The scored-occurrence cut (`SCORED_OCCURRENCES_MAX` in text-anchor.ts).
const CUT = 1024

fcTest.prop(
  [
    fc.integer({ min: 2200, max: 4000 }),
    fc.nat({ max: 4000 }),
    fc.integer({ min: CUT - 2, max: CUT + 1 }),
    fc.boolean(),
  ],
  withDefaults({ numRuns: 40 }),
)('keeps exactly the nearest CUT occurrences, the lower at a tie', (length, s, rank, miscount) => {
  // `a` at every odd position; the remembered prefix `c` is planted before the
  // occurrence of the drawn rank by (distance, position), so it decides the
  // answer exactly when that rank is inside the cut. A start on an occurrence
  // with a miscounted end reaches the cut with an occurrence AT the start.
  const body0 = `b${'ab'.repeat(Math.ceil(length / 2))}`.slice(0, length)
  const start = s % length
  const occurrences = textOccurrences(body0, 'a')
  const ranked = [...occurrences].sort((x, y) => Math.abs(x - start) - Math.abs(y - start) || x - y)
  const planted = ranked[rank] as number
  const body = `${body0.slice(0, planted - 1)}c${body0.slice(planted)}`
  const anchor = { ...anchorOf('a', start, 'c', undefined), end: start + (miscount ? 2 : 1) }
  if (body.slice(start, anchor.end) === 'a') return
  const among = resolveTextAnchorAmong(body, anchor, textOccurrences(body, 'a'))
  expect(among).toEqual(resolveTextAnchor(body, anchor))
  expect(among.kind === 'placed' && among.start === planted).toBe(rank < CUT)
})

fcTest('the dense generator reaches repeated quotes and missed offsets', () => {
  // Read after the property above has run: a floor that proves it compared
  // something other than the stored-offset shortcut.
  expect(reached.many).toBeGreaterThan(20)
  expect(reached.missed).toBeGreaterThan(20)
})
