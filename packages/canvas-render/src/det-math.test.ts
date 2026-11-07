import { describe, expect, it } from 'vitest'
import { compareNumbers, cos, hypot, sin } from './det-math.js'
import oracle from './det-math.oracle.txt?raw'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'

const fromBits = (hex: string): number => {
  const view = new DataView(new ArrayBuffer(8))
  view.setBigUint64(0, BigInt(`0x${hex}`))
  return view.getFloat64(0)
}
const bitsOf = (x: number): string => {
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, x)
  return view.getBigUint64(0).toString(16).padStart(16, '0')
}

const rows = oracle
  .split('\n')
  .filter((line) => line !== '' && !line.startsWith('#'))
  .map((line) => line.split(' ') as [string, string, string])

describe('sin and cos agree with fdlibm bit for bit', () => {
  it('reads an oracle worth reading', () => {
    expect(rows.length).toBeGreaterThan(800)
  })

  // Compared as bits, so a one-ulp difference and the sign of a zero both
  // count: either is what moves a coordinate's last printed digit.
  it('answers what the Rust libm crate answers, on every oracle input', () => {
    const differs = rows.filter(
      ([x, s, c]) => bitsOf(sin(fromBits(x))) !== s || bitsOf(cos(fromBits(x))) !== c,
    )
    expect(differs.map(([x]) => fromBits(x))).toEqual([])
  })

  it('answers NaN for a non-finite angle and past the reduction ceiling', () => {
    for (const x of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      1647099.3,
      1e7,
      -1e7,
    ]) {
      expect(sin(x)).toBeNaN()
      expect(cos(x)).toBeNaN()
    }
  })
})

describe('hypot is the naive formula, by design', () => {
  it('is exact on a Pythagorean triple, whichever the signs', () => {
    expect(hypot(3, 4)).toBe(5)
    expect(hypot(-3, -4)).toBe(5)
  })

  it('overflows where the naive formula does, as its Rust twin does', () => {
    // An engine's Math.hypot scales and answers ~1.414e200 here.
    expect(hypot(1e200, 1e200)).toBe(Number.POSITIVE_INFINITY)
  })
})

// Dense in what an ordering has to decide: both zeros, NaN, the infinities,
// and ties, beside ordinary doubles.
const key = fc.oneof(
  fc.constantFrom(0, -0, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1, -1),
  fc.double(),
)

describe('compareNumbers is a total order with a written NaN policy', () => {
  it('puts NaN after every number, and calls the two zeros equal', () => {
    expect([Number.NaN, 2, Number.NEGATIVE_INFINITY, -0, 1].sort(compareNumbers)).toEqual([
      Number.NEGATIVE_INFINITY,
      -0,
      1,
      2,
      Number.NaN,
    ])
    expect(compareNumbers(-0, 0)).toBe(0)
    expect(compareNumbers(Number.NaN, Number.NaN)).toBe(0)
  })

  fcTest.prop([key, key], withDefaults())(
    'has the sign a - b has wherever a - b is a number',
    (a, b) => {
      const difference = a - b
      if (Number.isNaN(difference)) return
      expect(compareNumbers(a, b)).toBe(Math.sign(difference) || 0)
    },
  )

  // What makes a sort's answer independent of the algorithm that computed it:
  // the comparator is a total preorder, so every algorithm agrees on the order
  // of unequal keys.
  fcTest.prop([key, key, key], withDefaults())('is antisymmetric and transitive', (a, b, c) => {
    expect(compareNumbers(a, b)).toBe(-compareNumbers(b, a) || 0)
    if (compareNumbers(a, b) <= 0 && compareNumbers(b, c) <= 0) {
      expect(compareNumbers(a, c)).toBeLessThanOrEqual(0)
    }
  })
})
