import { describe, expect, it } from 'vitest'
import type { FontDescriptor, MeasureText } from '../../measure.js'
import { createFakeMeasure } from '../../test-utils/fake-measure.js'
import { fc, fcTest, withDefaults } from '../../test-utils/fast-check.js'
import { fitToWidth } from './truncate.js'

/**
 * `fitToWidth` had no test of its own: every case reaching it came through a
 * caller pinning a RENDERED SCENE, which is why its three documented
 * clauses — no usable width returns the text, text that fits is left alone,
 * and a non-empty input never comes back empty — could each be deleted with
 * the whole suite still green. Mutation testing is what said so, and the
 * survivors landed exactly on those three lines.
 *
 * One UTF-16 unit per 10px, so every boundary below is arithmetic a reader
 * can check: `'ab'` is 20px wide, and an astral code point is 20px because
 * it is two units.
 */
const measure = createFakeMeasure(1)
const font: FontDescriptor = {
  family: 'Test',
  fallbackChain: [],
  weight: 400,
  style: 'normal',
  sizePx: 10,
}
const fit = (text: string, maxWidth: number) => fitToWidth(text, font, measure, maxWidth)

describe('fitToWidth: a width it cannot fit against', () => {
  // The documented fallback — "no width to fit against" returns the text
  // unchanged, matching how layout treats an unusable wrap width elsewhere.
  // Each case below is a mutant that survived: `||` -> `&&`, the condition
  // -> `false`, and `<= 0` -> `< 0`.
  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['zero', 0],
    ['negative', -20],
  ])('returns the text untouched and unmarked for %s', (_label, maxWidth) => {
    expect(fit('abcdef', maxWidth)).toEqual({ text: 'abcdef' })
  })
})

describe('fitToWidth: text that already fits', () => {
  it('is returned unchanged, with no truncation flag', () => {
    expect(fit('ab', 100)).toEqual({ text: 'ab' })
  })

  it('counts text exactly as wide as the box as fitting', () => {
    // The boundary `advance <= maxWidth`: at `<` this returns a cut 'a',
    // which is a visible glyph lost to a rounding-width label.
    expect(fit('ab', 20)).toEqual({ text: 'ab' })
  })
})

describe('fitToWidth: text that overflows', () => {
  it('keeps the longest prefix that fits and says it cut', () => {
    expect(fit('abcdef', 25)).toEqual({ text: 'ab', truncated: true })
  })

  it('keeps a prefix that ends exactly on the boundary', () => {
    // The loop's own boundary, `candidate > maxWidth` breaks: at `>=` the
    // prefix that measures exactly `maxWidth` is dropped for no reason.
    expect(fit('abcdef', 20)).toEqual({ text: 'ab', truncated: true })
  })
})

describe('fitToWidth: never empty', () => {
  it('keeps one code point even when that code point alone overflows', () => {
    // The clause the docstring gives a reason for — "one glyph over the edge
    // still says a label is there, and nothing at all does not" — and the
    // one nothing checked: deleting the fallback left every test green.
    expect(fit('abc', 5)).toEqual({ text: 'a', truncated: true })
  })

  it('keeps a whole astral code point rather than half a surrogate pair', () => {
    // `[...text][0]`, not `text[0]`: the latter returns a lone high surrogate,
    // which is not a character and is not valid XML content either.
    const emoji = String.fromCodePoint(0x1f600)
    expect(fit(`${emoji}x`, 5)).toEqual({ text: emoji, truncated: true })
  })

  it('still answers for the empty string', () => {
    expect(fit('', 20)).toEqual({ text: '' })
  })

  it('marks a kept-but-overflowing single code point as truncated (pinned counterexample)', () => {
    // Found by the property below, shrunk to `(' ', 1)`: the one code point
    // does not fit, the never-empty rule keeps it anyway, and NOTHING was
    // dropped — yet the result says `truncated`.
    //
    // Pinned as the current behaviour rather than changed, because which
    // reading is right is a product question, not a test one. `truncated` is
    // one fact with three readers: the SVG backend paints a FADE on it, and
    // `sceneDigest` reports it to an agent as "the document holds more than
    // the canvas shows" — which here is not true. Under that second reading
    // this is a small false signal; under "the content does not fit its box"
    // it is correct. Nothing in the codebase settles it, so this test states
    // what happens and the asymmetry is left visible in the property.
    expect(fit(' ', 1)).toEqual({ text: ' ', truncated: true })
  })
})

describe('fitToWidth: a measurer that misreports the empty string', () => {
  it('still answers with a string rather than undefined', () => {
    // Unreachable with a CONFORMING measurer — an empty string measures
    // zero, which fits any positive `maxWidth`, so the early return above
    // takes it, and Stryker reports the `?? ''` as uncovered rather than as
    // a survivor. It is not dead code: `measure.ts` states outright that a
    // measurer can violate its contract and that layout clamps instead of
    // trusting it, and this is the line that keeps `FittedText.text`'s
    // promise of a `string` under that. Without it this path hands
    // `{ text: undefined }` to every caller that spreads it onto a scene
    // node, where it becomes an SVG attribute reading `undefined`.
    const liar: MeasureText = (_text, f) => ({
      advanceWidth: 999,
      ascent: f.sizePx,
      descent: 0,
      lineGap: 0,
    })
    expect(fitToWidth('', font, liar, 20)).toEqual({ text: '', truncated: true })
  })
})

describe('fitToWidth properties', () => {
  const textArb = fc.string({ minLength: 1, maxLength: 12 })
  const widthArb = fc.integer({ min: 1, max: 130 })

  fcTest.prop([textArb, widthArb], withDefaults())(
    'the result is always a prefix of the input',
    (text, maxWidth) => {
      expect(text.startsWith(fit(text, maxWidth).text)).toBe(true)
    },
  )

  fcTest.prop([textArb, widthArb], withDefaults())(
    'a non-empty input never comes back empty',
    (text, maxWidth) => {
      expect(fit(text, maxWidth).text).not.toBe('')
    },
  )

  fcTest.prop([textArb, widthArb], withDefaults())(
    'it fits, or it is the one code point that could not',
    (text, maxWidth) => {
      const { text: result } = fit(text, maxWidth)
      const width = measure(result, font).advanceWidth
      expect(width <= maxWidth || [...result].length === 1).toBe(true)
    },
  )

  fcTest.prop([textArb, widthArb], withDefaults())(
    'anything it shortened is marked truncated',
    (text, maxWidth) => {
      // ONE direction only. The converse is false, and the property found the
      // case: a single code point too wide for the box is kept and still
      // marked — see the pinned counterexample above.
      const fitted = fit(text, maxWidth)
      if (fitted.text !== text) expect(fitted.truncated).toBe(true)
    },
  )

  fcTest.prop([textArb, widthArb, widthArb], withDefaults())(
    'more room never returns less text',
    (text, a, b) => {
      const [narrow, wide] = a <= b ? [a, b] : [b, a]
      expect(fit(text, wide).text.length).toBeGreaterThanOrEqual(fit(text, narrow).text.length)
    },
  )
})
