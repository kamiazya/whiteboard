import { describe, expect, it } from 'vitest'
import { compareCodeUnit } from './code-unit-order.js'

describe('compareCodeUnit', () => {
  it('answers 0 for equal keys, so neither is greater than the other', () => {
    expect(compareCodeUnit('a', 'a')).toBe(0)
    expect(compareCodeUnit('', '')).toBe(0)
  })

  it('orders by UTF-16 code unit, not by locale', () => {
    expect(compareCodeUnit('a', 'b')).toBeLessThan(0)
    expect(compareCodeUnit('b', 'a')).toBeGreaterThan(0)
    expect(compareCodeUnit('Z', 'a')).toBeLessThan(0)
    expect(compareCodeUnit('a', 'ab')).toBeLessThan(0)
    // a locale collation puts an accented e before f; its code unit is far past it
    expect(compareCodeUnit('é', 'f')).toBeGreaterThan(0)
  })

  it('compares surrogate code units, not code points', () => {
    // U+10000 is the pair D800 DC00, which sorts before U+FFFF as one unit
    expect(compareCodeUnit('\u{10000}', '￿')).toBeLessThan(0)
  })

  it('is antisymmetric', () => {
    for (const [x, y] of [
      ['a', 'b'],
      ['x', 'x'],
      ['ab', 'a'],
    ] as const) {
      expect(Math.sign(compareCodeUnit(x, y)) + Math.sign(compareCodeUnit(y, x))).toBe(0)
    }
  })
})
