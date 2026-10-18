import { describe, expect, it } from 'vitest'
import { fc, withDefaults } from '../test-utils/fast-check.js'
import { looseOccurrences } from './loose-occurrences.js'

/**
 * The whitespace-loose regex this search replaced, kept as the oracle: it is
 * solved by a different machine (the regex engine, not squashing plus an exact
 * search), so agreement means something.
 */
function regexOccurrences(text: string, quote: string): { start: number; end: number }[] {
  if (quote.trim() === '') return []
  const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(quote.trim().split(/\s+/).map(escapeRegExp).join('\\s+'), 'g')
  return Array.from(text.matchAll(pattern), (match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }))
}

// A tiny alphabet so occurrences, overlaps and whitespace runs are dense.
const char = fc.constantFrom('a', 'b', '.', '*', ' ', '  ', '\n', '\t')
const text = fc.array(char, { maxLength: 40 }).map((chars) => chars.join(''))

describe('looseOccurrences', () => {
  it('finds exactly the spans the whitespace-loose regex finds', () => {
    let hits = 0
    let samples = 0
    fc.assert(
      fc.property(
        text,
        fc.oneof(text, fc.tuple(text, fc.nat(), fc.nat())),
        (body, quoteOrSlice) => {
          // Half the quotes are cut from the body itself, so most of them occur.
          const quote =
            typeof quoteOrSlice === 'string'
              ? quoteOrSlice
              : body.slice(
                  quoteOrSlice[1] % (body.length + 1),
                  (quoteOrSlice[1] % (body.length + 1)) + (quoteOrSlice[2] % 12),
                )
          const expected = regexOccurrences(body, quote)
          samples += 1
          if (expected.length > 0) hits += 1
          expect(looseOccurrences(body, quote)).toEqual(expected)
        },
      ),
      withDefaults({ numRuns: 2000 }),
    )
    // Reachability: a property over quotes that never occur asserts nothing.
    expect(hits / samples).toBeGreaterThan(0.25)
  })

  it("reads any whitespace run in the text as the quote's one space", () => {
    expect(looseOccurrences('x  a \n\tb y', 'a b')).toEqual([{ start: 3, end: 8 }])
  })

  it('counts overlapping repeats once, leftmost first', () => {
    expect(looseOccurrences('a a a', 'a a')).toEqual([{ start: 0, end: 3 }])
  })

  it('finds nothing for a blank quote or one longer than the text', () => {
    expect(looseOccurrences('a a', ' \n ')).toEqual([])
    expect(looseOccurrences('a a', 'a a a')).toEqual([])
  })
})
