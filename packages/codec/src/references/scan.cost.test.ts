import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { type ReferenceMatch, scanReferences } from './scan.js'

/**
 * `value` behind a proxy that counts every character the scanner looks at:
 * one per index read, the span an `indexOf` walked, the length a `slice`
 * copied. A count is what makes "linear" a property a test can hold — a
 * timing bound passes on a fast machine and flakes on a loaded one. Any
 * other member the scanner reaches for throws, so a new access path cannot
 * slip past the count.
 */
function counted(value: string): { text: string; visits: () => number } {
  let visits = 0
  const proxy = new Proxy(new String(value), {
    get(_target, key) {
      if (key === 'length') return value.length
      if (typeof key === 'string' && /^\d+$/.test(key)) {
        visits++
        return value[Number(key)]
      }
      if (key === 'indexOf') {
        return (needle: string, from = 0) => {
          const at = value.indexOf(needle, from)
          visits += (at === -1 ? value.length : at + needle.length) - from
          return at
        }
      }
      if (key === 'slice') {
        return (start?: number, end?: number) => {
          const out = value.slice(start, end)
          visits += out.length
          return out
        }
      }
      throw new Error(`the scanner read ${String(key)}, which this count does not cover`)
    },
  })
  return { text: proxy as unknown as string, visits: () => visits }
}

/** Character visits per character of input — bounded by a constant iff the scan is linear. */
function visitsPerChar(value: string): number {
  const { text, visits } = counted(value)
  scanReferences(text)
  return visits() / value.length
}

/**
 * A reference oracle built on different machinery — a regex over the same
 * grammar — so a mistake the scanner makes is not made twice. The target may
 * not start with `#` (that is an empty document half) nor hold `]`/`|`; the
 * `!` belongs to the match when it sits right before the `[[`.
 */
function regexOracle(value: string): ReferenceMatch[] {
  const pattern = /(!?)\[\[([^\]|#][^\]|]*)(?:\|([^\]]*))?\]\]/g
  return [...value.matchAll(pattern)].map((match) => {
    const raw = match[2] as string
    const hash = raw.indexOf('#')
    const fragment = hash === -1 ? undefined : raw.slice(hash + 1)
    return {
      index: match.index,
      full: match[0],
      isEmbed: match[1] === '!',
      target: hash === -1 ? raw : raw.slice(0, hash),
      alias: match[3],
      fragment: fragment === undefined || fragment.length === 0 ? undefined : fragment,
    }
  })
}

const N = 4000

describe('scanReferences, counted', () => {
  it.each([
    ['openers whose targets are all empty fragments', `${'[[#'.repeat(N)}]`],
    ['openers with no terminator at all', '[['.repeat(N)],
    ['one opener and a run of pipes', `[[${'a|'.repeat(N)}`],
    ['half-closed references', '[[a] '.repeat(N)],
    ['empty-fragment openers before a real reference', `${'[[#'.repeat(N)}[[a]]`],
    ['closed references back to back', '[[a]] '.repeat(N)],
  ])('visits each character a bounded number of times: %s', (_shape, value) => {
    expect(visitsPerChar(value)).toBeLessThan(6)
  })

  it('finds the reference after a run of empty-fragment openers', () => {
    const value = `${'[[#'.repeat(50)}[[a]]`
    expect(scanReferences(value).map((match) => match.target)).toEqual(['a'])
  })
})

// Built from the grammar's own pieces rather than single characters: a
// character alphabet assembles `[[` and `]]` around a target so rarely that
// the differential compared almost nothing (5 matching samples in 2000;
// these pieces reach about 240, about 60 of them after a `[[#`).
const PIECE = fc.constantFrom(
  '[[',
  ']]',
  '[[#',
  '[[#',
  'a]]',
  '![[',
  '[',
  ']',
  '|',
  '#',
  '!',
  'a',
  'b',
  ' ',
)
const textArbitrary = fc.array(PIECE, { maxLength: 16 }).map((pieces) => pieces.join(''))

describe('scanReferences, against a regex oracle', () => {
  fcTest.prop([textArbitrary], withDefaults())(
    'finds exactly what the grammar matches',
    (value) => {
      expect(scanReferences(value)).toEqual(regexOracle(value))
    },
  )

  it('the generator reaches references, including ones after an empty fragment', () => {
    const samples = fc.sample(textArbitrary, { numRuns: 2000 })
    const withMatch = samples.filter((value) => regexOracle(value).length > 0)
    const afterEmptyFragment = samples.filter((value) =>
      regexOracle(value).some((match) => value.lastIndexOf('[[#', match.index) !== -1),
    )
    expect(withMatch.length).toBeGreaterThan(150)
    expect(afterEmptyFragment.length).toBeGreaterThan(25)
  })

  fcTest.prop([textArbitrary], withDefaults())(
    'visits each character a bounded number of times on any input',
    (value) => {
      fc.pre(value.length > 0)
      expect(visitsPerChar(value)).toBeLessThan(8)
    },
  )
})
