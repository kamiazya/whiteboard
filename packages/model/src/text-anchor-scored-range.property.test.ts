/**
 * `scoredOccurrenceRange` against its definition: the `max` occurrences
 * nearest a position, the lower of two equally near first. The oracle sorts
 * every occurrence by (distance, position) and takes a prefix — no split, no
 * merge, nothing the subject's outward walk uses.
 */
import { describe, expect } from 'vitest'
import { fc, fcTest } from './test-utils/fast-check.js'
import { scoredOccurrenceRange } from './text-anchor.js'

const nearestByDefinition = (sorted: readonly number[], around: number, max: number): number[] =>
  [...sorted]
    .sort((a, b) => Math.abs(a - around) - Math.abs(b - around) || a - b)
    .slice(0, max)
    .sort((a, b) => a - b)

// Small positions and small caps, so the cut lands inside the list, on a tie,
// and at either end often.
const sortedPositions = fc
  .uniqueArray(fc.integer({ min: 0, max: 60 }), { maxLength: 40 })
  .map((xs) => [...xs].sort((a, b) => a - b))

describe('scoredOccurrenceRange', () => {
  fcTest.prop([sortedPositions, fc.integer({ min: -5, max: 70 }), fc.integer({ min: 0, max: 12 })])(
    'holds exactly the max nearest, the lower kept at a tie',
    (sorted, around, max) => {
      const { from, to } = scoredOccurrenceRange(sorted, around, max)
      expect(sorted.slice(from, to)).toEqual(nearestByDefinition(sorted, around, max))
    },
  )

  fcTest.prop([sortedPositions, fc.integer({ min: -5, max: 70 })])(
    'keeps every occurrence under the default bound',
    (sorted, around) => {
      expect(scoredOccurrenceRange(sorted, around)).toEqual({ from: 0, to: sorted.length })
    },
  )
})
