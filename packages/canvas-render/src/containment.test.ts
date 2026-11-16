import { describe, expect, it } from 'vitest'
import { fullyContains } from './containment.js'

const rectAt = (x: number, y: number, w = 100, h = 100) => ({ x, y, w, h })

describe('fullyContains', () => {
  const outer = rectAt(0, 0)

  // All four comparisons are INCLUSIVE, so a rect sharing an edge with its
  // container is still inside it — which is what lets a group frame hold a
  // member flush against its own border. Nothing reached a coincident edge,
  // and each side is its own comparison.
  it.each([
    ['left', rectAt(0, 10, 50, 50)],
    ['top', rectAt(10, 0, 50, 50)],
    ['right', rectAt(50, 10, 50, 50)],
    ['bottom', rectAt(10, 50, 50, 50)],
  ])('contains a rect flush against its %s edge', (_edge, inner) => {
    expect(fullyContains(outer, inner)).toBe(true)
  })

  it('contains an identical rect — every edge coincident at once', () => {
    expect(fullyContains(outer, rectAt(0, 0))).toBe(true)
  })

  it('rejects a rect that pokes out by a single pixel, on each side', () => {
    expect(fullyContains(outer, rectAt(-1, 10, 50, 50))).toBe(false)
    expect(fullyContains(outer, rectAt(10, -1, 50, 50))).toBe(false)
    expect(fullyContains(outer, rectAt(51, 10, 50, 50))).toBe(false)
    expect(fullyContains(outer, rectAt(10, 51, 50, 50))).toBe(false)
  })
})
