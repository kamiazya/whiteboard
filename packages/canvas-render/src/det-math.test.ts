import { describe, expect, it } from 'vitest'
import { cos, hypot, sin } from './det-math.js'
import oracle from './det-math.oracle.txt?raw'

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
