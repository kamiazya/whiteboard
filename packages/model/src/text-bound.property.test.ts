/**
 * The growth rule every text bound is held to, by both keepers and by every
 * editor: an edit is refused only when it ends past the bound AND longer than
 * it started. Stated as the three things a person can observe — a text within
 * the bound is always taken, a text already past it can always shrink, and
 * growth that ends past it never lands — rather than as the comparison the
 * rule is written with.
 */
import { describe, expect } from 'vitest'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'
import { growsPast } from './text-bound.js'

/**
 * Lengths drawn around the bound, so `before` lands on either side of it —
 * and on it — about as often as not; every `after` is walked or derived from
 * it. A domain of all naturals would put almost every draw far past a small
 * bound and reach the "within" cases only by luck.
 */
const max = fc.integer({ min: 0, max: 64 })
const around = (bound: number) => fc.integer({ min: Math.max(0, bound - 8), max: bound + 8 })
/** A bound and the length a text had before the edit. */
const edit = max.chain((bound) => fc.tuple(fc.constant(bound), around(bound)))

describe('growsPast', () => {
  fcTest.prop([edit], withDefaults())(
    'takes any text that ends within the bound',
    ([bound, before]) => {
      for (let after = 0; after <= bound; after += 1) {
        expect(growsPast(bound, before, after)).toBe(false)
      }
    },
  )

  fcTest.prop([edit], withDefaults())(
    'lets a text past the bound shrink or stay as long, so it is never stuck',
    ([bound, before]) => {
      for (let after = 0; after <= before; after += 1) {
        expect(growsPast(bound, before, after)).toBe(false)
      }
    },
  )

  fcTest.prop([edit, fc.integer({ min: 1, max: 16 })], withDefaults())(
    'refuses growth that ends past the bound, by any amount',
    ([bound, before], by) => {
      const after = Math.max(before, bound) + by
      expect(growsPast(bound, before, after)).toBe(true)
    },
  )
})
