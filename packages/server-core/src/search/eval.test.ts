import { describe, expect, it } from 'vitest'
import {
  bootstrapCi,
  ndcgAt,
  pairedPermutationTest,
  permutationFloor,
  randomBaseline,
  recallAt,
  reciprocalRank,
  requiredQueryCount,
} from './eval.js'

const LOG2_3 = Math.log2(3)

describe('ndcgAt', () => {
  it('is 1 when the best document is first', () => {
    expect(ndcgAt(['a', 'b'], { a: 2 }, 2)).toBeCloseTo(1, 10)
  })

  it('discounts by log2(rank + 1) — hand-computed', () => {
    // DCG = 0 + (2^2 - 1)/log2(3); ideal = (2^2 - 1)/log2(2) = 3
    expect(ndcgAt(['x', 'a'], { a: 2 }, 2)).toBeCloseTo(3 / LOG2_3 / 3, 10)
  })

  it('uses the GRADED gain 2^rel - 1, so a 3 outranks a 1 by more than 3x', () => {
    // ranked [y, x] with x=3, y=1
    const dcg = 1 / 1 + 7 / LOG2_3
    const ideal = 7 / 1 + 1 / LOG2_3
    expect(ndcgAt(['y', 'x'], { x: 3, y: 1 }, 2)).toBeCloseTo(dcg / ideal, 10)
  })

  it('is 0 when nothing relevant is in the cut', () => {
    expect(ndcgAt(['a', 'b'], { c: 2 }, 2)).toBe(0)
  })

  it('is 0, not NaN, when a query has no relevant document at all', () => {
    // An unjudged query would otherwise divide by an ideal DCG of zero and
    // poison every mean it is averaged into.
    expect(ndcgAt(['a'], {}, 5)).toBe(0)
  })

  it('honours the cut: a hit past k does not count', () => {
    expect(ndcgAt(['x', 'x', 'a'], { a: 2 }, 2)).toBe(0)
    expect(ndcgAt(['x', 'x', 'a'], { a: 2 }, 3)).toBeGreaterThan(0)
  })

  it('caps the ideal at k, so k smaller than the relevant set still reaches 1', () => {
    expect(ndcgAt(['a', 'b'], { a: 2, b: 2, c: 2 }, 2)).toBeCloseTo(1, 10)
  })
})

describe('recallAt and reciprocalRank', () => {
  it('recall counts distinct relevant documents inside the cut', () => {
    expect(recallAt(['a', 'x', 'b'], { a: 2, b: 1, c: 3 }, 3)).toBeCloseTo(2 / 3, 10)
  })

  it('recall is 0 for a query with no relevant document', () => {
    expect(recallAt(['a'], {}, 5)).toBe(0)
  })

  it('reciprocal rank is 1/rank of the first relevant hit, 0 if none', () => {
    expect(reciprocalRank(['x', 'a'], { a: 2 }, 5)).toBeCloseTo(0.5, 10)
    expect(reciprocalRank(['x'], { a: 2 }, 5)).toBe(0)
  })
})

describe('pairedPermutationTest', () => {
  it('reports p = 1 when every difference is zero', () => {
    expect(pairedPermutationTest([0, 0, 0, 0], { trials: 200 }).p).toBe(1)
  })

  it('is significant when every query improves by the same amount', () => {
    // Only the all-same-sign assignments reach |observed|, so p tracks
    // 2/2^n — the floor a paired sign-flip test can reach at this n.
    const result = pairedPermutationTest(Array(12).fill(0.3), { trials: 5000 })
    expect(result.p).toBeLessThan(0.01)
  })

  it('cannot reach significance at all with too few queries', () => {
    // 2/2^3 = 0.25. Three queries cannot produce a p below 0.05 however
    // large the effect — the reason a corpus size is a design parameter
    // and not an afterthought.
    expect(pairedPermutationTest([9, 9, 9], { trials: 5000 }).p).toBeGreaterThan(0.2)
  })

  it('is deterministic for a given seed', () => {
    const deltas = [0.4, -0.1, 0.2, 0.9, -0.3, 0.5, 0.1, 0.2]
    const a = pairedPermutationTest(deltas, { trials: 1000, seed: 7 })
    const b = pairedPermutationTest(deltas, { trials: 1000, seed: 7 })
    expect(a.p).toBe(b.p)
    expect(pairedPermutationTest(deltas, { trials: 1000, seed: 8 }).p).not.toBe(a.p)
  })

  it('never reports p = 0, because a sampled test cannot prove impossibility', () => {
    expect(pairedPermutationTest(Array(40).fill(1), { trials: 100 }).p).toBeGreaterThan(0)
  })

  it('flags a p that is only the SAMPLER running out of resolution', () => {
    // 40 queries all improving: the exact p is around 2^-39, far below
    // anything 100 trials can express, so the reported 1/101 is a property
    // of the trial count rather than of the evidence.
    const pinned = pairedPermutationTest(Array(40).fill(1), { trials: 100 })
    expect(pinned.atSamplingFloor).toBe(true)
    expect(pinned.p).toBeCloseTo(1 / 101, 12)
    // A genuinely middling p is not flagged.
    const ordinary = pairedPermutationTest([1, -1, 0.5, -0.4, 0.2], { trials: 5000 })
    expect(ordinary.atSamplingFloor).toBe(false)
  })
})

describe('pairedPermutationTest against exact enumeration', () => {
  /**
   * The independent reference: every one of the 2^n sign assignments,
   * counted rather than sampled. Written here in the test and deliberately
   * NOT shared with the implementation, so agreement between them is
   * evidence rather than a tautology.
   */
  function exactP(deltas: readonly number[]): number {
    const n = deltas.length
    const target = Math.abs(deltas.reduce((a, b) => a + b, 0) / n)
    let atLeastAsExtreme = 0
    for (let mask = 0; mask < 2 ** n; mask++) {
      let sum = 0
      for (let i = 0; i < n; i++)
        sum += (mask >> i) & 1 ? -(deltas[i] as number) : (deltas[i] as number)
      if (Math.abs(sum / n) >= target - 1e-12) atLeastAsExtreme++
    }
    return atLeastAsExtreme / 2 ** n
  }

  it.each([
    [[0.4, -0.1, 0.2, 0.9, -0.3, 0.5, 0.1, 0.2]],
    [[1, 1, 1, 1, 1, 1]],
    [[0.1, 0, -0.2, 0.35, 0, 0.05, -0.4, 0.9, 0.15]],
    [[-0.5, -0.2, -0.7, 0.1]],
  ])('agrees with exhaustive enumeration on %j', (deltas) => {
    const sampled = pairedPermutationTest(deltas, { trials: 200_000, seed: 42 })
    expect(sampled.p).toBeCloseTo(exactP(deltas), 2)
  })

  it('agrees on the direction and magnitude of the observed statistic', () => {
    const deltas = [0.4, -0.1, 0.2, 0.9]
    const expected = deltas.reduce((a, b) => a + b, 0) / deltas.length
    expect(pairedPermutationTest(deltas, { trials: 100 }).observed).toBeCloseTo(expected, 12)
  })
})

describe('permutationFloor', () => {
  it('is driven by how many queries DIFFER, not how many were asked', () => {
    expect(permutationFloor([1, 1, 1, 0, 0, 0, 0, 0, 0])).toBeCloseTo(2 ** -2, 12)
    expect(permutationFloor([1, 1, 1])).toBeCloseTo(2 ** -2, 12)
  })

  it('is the level an all-one-way sample is pinned to', () => {
    // Six queries all improving cannot do better than 2^-5 = 0.031, so a
    // p that looks like a pass is really the only pass available. The
    // sampled test scatters around the exact value rather than being
    // bounded by it, hence the tolerance.
    const deltas = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0, 0]
    const floor = permutationFloor(deltas)
    expect(floor).toBeCloseTo(0.03125, 12)
    expect(pairedPermutationTest(deltas, { trials: 20_000 }).p).toBeCloseTo(floor, 2)
  })

  it('is 1 when nothing differs, because no evidence is possible', () => {
    expect(permutationFloor([0, 0, 0])).toBe(1)
  })
})

describe('bootstrapCi', () => {
  it('collapses to the value itself when every observation is identical', () => {
    const ci = bootstrapCi([2, 2, 2, 2], { resamples: 200 })
    expect(ci.low).toBeCloseTo(2, 10)
    expect(ci.high).toBeCloseTo(2, 10)
  })

  it('brackets the observed mean', () => {
    const values = [0.1, 0.4, 0.2, 0.8, 0.5, 0.3, 0.6, 0.2, 0.7, 0.4]
    const ci = bootstrapCi(values, { resamples: 4000, seed: 3 })
    const mean = values.reduce((a, b) => a + b, 0) / values.length
    expect(ci.low).toBeLessThan(mean)
    expect(ci.high).toBeGreaterThan(mean)
  })

  it('narrows as the sample grows', () => {
    const small = bootstrapCi([0, 1, 0, 1, 0, 1], { resamples: 3000, seed: 1 })
    const large = bootstrapCi(
      Array.from({ length: 600 }, (_, i) => i % 2),
      {
        resamples: 3000,
        seed: 1,
      },
    )
    expect(large.high - large.low).toBeLessThan(small.high - small.low)
  })
})

describe('requiredQueryCount', () => {
  it('follows the paired-difference sample size formula', () => {
    // n = (z_{a/2} + z_power)^2 * sd^2 / minD^2, rounded up.
    // sd = 1, minD = 1, a = .05, power = .8 -> (1.95996 + 0.84162)^2 = 7.849
    expect(requiredQueryCount({ sd: 1, minDetectable: 1 })).toBe(8)
  })

  it('grows with the square of the ratio it has to resolve', () => {
    expect(requiredQueryCount({ sd: 1, minDetectable: 0.5 })).toBe(32)
  })

  it('is unanswerable when there is no difference to detect', () => {
    expect(requiredQueryCount({ sd: 1, minDetectable: 0 })).toBeUndefined()
  })
})

describe('randomBaseline', () => {
  it('scores what a ranking that knows nothing would score', () => {
    // One relevant document among 10, cut at 10: every rank equally likely,
    // so mean nDCG = (1/10) * sum_{r=1..10} 1/log2(r+1).
    const expected =
      Array.from({ length: 10 }, (_, i) => 1 / Math.log2(i + 2)).reduce((a, b) => a + b, 0) / 10
    const actual = randomBaseline({
      corpusSize: 10,
      relevantCount: 1,
      k: 10,
      trials: 20000,
      seed: 5,
    })
    expect(actual.ndcg).toBeCloseTo(expected, 2)
  })

  it('is deterministic for a given seed', () => {
    const args = { corpusSize: 20, relevantCount: 2, k: 10, trials: 2000, seed: 11 } as const
    expect(randomBaseline(args)).toEqual(randomBaseline(args))
  })
})
