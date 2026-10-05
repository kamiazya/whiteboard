import { describe, expect, it } from 'vitest'
import { boundsOf } from './bounds.js'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'

const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height })

describe('boundsOf', () => {
  it('covers every box it is given', () => {
    expect(boundsOf([box(10, 20, 30, 40), box(100, 0, 10, 10)])).toEqual(box(10, 0, 100, 60))
  })

  it('is the box itself for a single member', () => {
    expect(boundsOf([box(5, 6, 7, 8)])).toEqual(box(5, 6, 7, 8))
  })

  it('has no answer for an empty list', () => {
    expect(boundsOf([])).toBeUndefined()
  })

  it('reaches into negative coordinates', () => {
    expect(boundsOf([box(-50, -20, 10, 10), box(-5, -40, 20, 5)])).toEqual(box(-50, -40, 65, 30))
  })

  it('does not run out of stack on a very large selection', () => {
    const many = Array.from({ length: 200_000 }, (_, i) => box(i, -i, 1, 1))
    expect(boundsOf(many)).toEqual(box(0, -199_999, 200_000, 200_000))
  })

  // Integer geometry keeps the edge sums exact, so containment and
  // tightness can be read with `===` rather than an epsilon.
  const rect = fc.record({
    x: fc.integer({ min: -1000, max: 1000 }),
    y: fc.integer({ min: -1000, max: 1000 }),
    width: fc.integer({ min: 0, max: 500 }),
    height: fc.integer({ min: 0, max: 500 }),
  })

  fcTest.prop([fc.array(rect, { minLength: 1, maxLength: 12 })], withDefaults())(
    'contains every box, and each of its edges is some box’s edge',
    (rects) => {
      const bounds = boundsOf(rects)
      if (bounds === undefined) throw new Error('a non-empty list has bounds')
      const right = bounds.x + bounds.width
      const bottom = bounds.y + bounds.height
      for (const r of rects) {
        expect(r.x).toBeGreaterThanOrEqual(bounds.x)
        expect(r.y).toBeGreaterThanOrEqual(bounds.y)
        expect(r.x + r.width).toBeLessThanOrEqual(right)
        expect(r.y + r.height).toBeLessThanOrEqual(bottom)
      }
      expect(rects.some((r) => r.x === bounds.x)).toBe(true)
      expect(rects.some((r) => r.y === bounds.y)).toBe(true)
      expect(rects.some((r) => r.x + r.width === right)).toBe(true)
      expect(rects.some((r) => r.y + r.height === bottom)).toBe(true)
    },
  )
})
