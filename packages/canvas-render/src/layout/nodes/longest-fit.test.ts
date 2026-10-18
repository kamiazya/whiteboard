import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../../test-utils/fast-check.js'
import { longestFittingCount } from './longest-fit.js'

/**
 * The oracle is the scan the search replaced, written from its definition:
 * walk up from one and stop at the first count that does not fit.
 */
function firstFailureScan(fits: (n: number) => boolean, limit: number): number {
  let n = 0
  while (n < limit && fits(n + 1)) n += 1
  return n
}

/** A prefix-closed predicate: everything up to `threshold` fits. */
const upTo = (threshold: number) => (n: number) => n <= threshold

describe('longestFittingCount', () => {
  fcTest.prop(
    [
      fc.integer({ min: 0, max: 300 }),
      fc.integer({ min: 0, max: 400 }),
      fc.integer({ min: -5, max: 500 }),
    ],
    withDefaults(),
  )(
    'agrees with the first-failure scan for every threshold, limit and guess',
    (threshold, limit, guess) => {
      const fits = upTo(threshold)
      expect(longestFittingCount(fits, limit, guess)).toBe(firstFailureScan(fits, limit))
    },
  )

  fcTest.prop(
    [
      fc.integer({ min: 0, max: 300 }),
      fc.integer({ min: 1, max: 400 }),
      fc.integer({ min: 1, max: 500 }),
    ],
    withDefaults(),
  )(
    'has measured the count one past its answer whenever that count exists',
    (threshold, limit, guess) => {
      const probed = new Set<number>()
      const answer = longestFittingCount(
        (n) => {
          probed.add(n)
          return n <= threshold
        },
        limit,
        guess,
      )
      if (answer < limit) expect(probed.has(answer + 1)).toBe(true)
      expect(probed.has(0)).toBe(false)
      for (const n of probed) expect(n >= 1 && n <= limit).toBe(true)
    },
  )

  fcTest.prop(
    [fc.integer({ min: 0, max: 5000 }), fc.integer({ min: 1, max: 5000 })],
    withDefaults(),
  )('never probes further past its answer than twice the answer', (threshold, guess) => {
    const limit = 10_000
    let furthest = 0
    const answer = longestFittingCount(
      (n) => {
        furthest = Math.max(furthest, n)
        return n <= threshold
      },
      limit,
      1,
    )
    expect(furthest).toBeLessThanOrEqual(2 * answer + 1)
    // A guess moves where the search starts, never what it answers.
    expect(longestFittingCount(upTo(threshold), limit, guess)).toBe(answer)
  })

  it('settles a correct guess in two probes', () => {
    let probes = 0
    const answer = longestFittingCount(
      (n) => {
        probes += 1
        return n <= 40
      },
      1000,
      40,
    )
    expect(answer).toBe(40)
    expect(probes).toBe(2)
  })

  it('answers zero without probing when nothing is left to place', () => {
    let probes = 0
    expect(
      longestFittingCount(
        () => {
          probes += 1
          return true
        },
        0,
        3,
      ),
    ).toBe(0)
    expect(probes).toBe(0)
  })

  it('answers the limit when everything fits', () => {
    expect(longestFittingCount(() => true, 37, 5)).toBe(37)
  })
})
