import { describe, expect, it } from 'vitest'
import { area, contains, overlapArea, rectOf, round2 } from './rect.js'

const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h })

describe('quality rect arithmetic', () => {
  it('reads a node as x, y, w, h', () => {
    expect(rectOf({ x: 1, y: 2, width: 3, height: 4 } as Parameters<typeof rectOf>[0])).toEqual(
      box(1, 2, 3, 4),
    )
  })

  it('shares no area between rectangles that only touch, and the product where they cross', () => {
    expect(overlapArea(box(0, 0, 10, 10), box(10, 0, 10, 10))).toBe(0)
    expect(overlapArea(box(0, 0, 10, 10), box(20, 20, 5, 5))).toBe(0)
    expect(overlapArea(box(0, 0, 10, 10), box(5, 6, 10, 10))).toBe(20)
  })

  it('contains an identical rectangle and one sharing a border, but not one poking out', () => {
    expect(contains(box(0, 0, 10, 10), box(0, 0, 10, 10))).toBe(true)
    expect(contains(box(0, 0, 10, 10), box(0, 0, 4, 10))).toBe(true)
    expect(contains(box(0, 0, 10, 10), box(5, 5, 6, 2))).toBe(false)
  })

  it('rounds to two decimals and measures area', () => {
    expect(round2(1.005 + 0.2349)).toBe(1.24)
    expect(area(box(0, 0, 3, 4))).toBe(12)
  })
})
