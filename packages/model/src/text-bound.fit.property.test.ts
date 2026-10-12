/**
 * `fitToLength` against what a stored bound needs of it: the result parses
 * under a Zod `.max(max)` (which counts UTF-16 units), is a prefix of what it
 * was given, keeps as much as the bound allows, and never ends in half of a
 * surrogate pair it cut through.
 */
import { describe, expect } from 'vitest'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'
import { fitToLength } from './text-bound.js'

const isHigh = (unit: number) => unit >= 0xd800 && unit <= 0xdbff
const isLow = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff

/**
 * Text built from few, chosen pieces — an astral character, a lone half of
 * each kind, and a plain letter — so a bound lands inside a pair often rather
 * than by luck, and the unpaired halves real input can hold are drawn too.
 */
const unit = fc.constantFrom('a', '\u{1F600}', '\uD83D', '\uDE00')
const text = fc.array(unit, { maxLength: 24 }).map((pieces) => pieces.join(''))
const textAndBound = text.chain((value) =>
  fc.tuple(fc.constant(value), fc.integer({ min: 0, max: value.length + 2 })),
)

describe('fitToLength', () => {
  fcTest.prop([textAndBound], withDefaults())(
    'answers a prefix of the text no longer than the bound',
    ([value, max]) => {
      const fitted = fitToLength(value, max)
      expect(fitted.length).toBeLessThanOrEqual(max)
      expect(value.startsWith(fitted)).toBe(true)
    },
  )

  fcTest.prop([textAndBound], withDefaults())(
    'keeps a text within the bound whole, and cuts a longer one at the bound unless a pair straddles it',
    ([value, max]) => {
      const fitted = fitToLength(value, max)
      if (value.length <= max) expect(fitted).toBe(value)
      else if (fitted.length !== max) {
        // One unit short only to keep a character whole.
        expect(fitted).toHaveLength(max - 1)
        expect(isHigh(value.charCodeAt(max - 1)) && isLow(value.charCodeAt(max))).toBe(true)
      }
    },
  )

  fcTest.prop([textAndBound], withDefaults())(
    'never ends in the high half of a pair whose low half it dropped',
    ([value, max]) => {
      const fitted = fitToLength(value, max)
      if (fitted.length === 0 || fitted.length === value.length) return
      const split =
        isHigh(fitted.charCodeAt(fitted.length - 1)) && isLow(value.charCodeAt(fitted.length))
      expect(split).toBe(false)
    },
  )

  fcTest.prop([text, text], withDefaults())(
    'drops an astral character the bound falls inside, whole',
    (before, after) => {
      const value = `${before}\u{1F600}${after}`
      expect(fitToLength(value, before.length + 1)).toBe(before)
    },
  )
})
