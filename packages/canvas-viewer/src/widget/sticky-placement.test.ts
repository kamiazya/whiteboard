import { describe, expect, it } from 'vitest'
import { computeStickyPlacement, STICKY_PLACEMENT_MARGIN } from './sticky-placement.js'

describe('computeStickyPlacement', () => {
  it('falls back to the origin when the scene has no elements', () => {
    expect(computeStickyPlacement([])).toEqual({ x: 0, y: 0 })
  })

  it('falls back to the origin when no element has finite numeric geometry', () => {
    const elements = [
      { id: 'no-geometry' },
      { id: 'string-coords', x: '10', y: '10', width: 20, height: 20 },
      { id: 'nan', x: Number.NaN, y: 0, width: 20, height: 20 },
      { id: 'infinite', x: Number.POSITIVE_INFINITY, y: 0, width: 20, height: 20 },
      { id: 'partial', x: 0, y: 0, width: 20 },
    ]
    expect(computeStickyPlacement(elements)).toEqual({ x: 0, y: 0 })
  })

  it('excludes isDeleted elements from the bounds computation', () => {
    const elements = [
      { id: 'live', x: 0, y: 0, width: 100, height: 50 },
      { id: 'deleted', x: 1000, y: 1000, width: 10, height: 10, isDeleted: true },
    ]
    expect(computeStickyPlacement(elements)).toEqual({
      x: 100 + STICKY_PLACEMENT_MARGIN,
      y: 0,
    })
  })

  it('places to the right of the eligible content bounding box, top-aligned to minY', () => {
    const elements = [
      { id: 'a', x: 0, y: 30, width: 100, height: 50 },
      { id: 'b', x: 50, y: 0, width: 40, height: 20 },
    ]
    // maxX across elements = max(0+100, 50+40) = 100; minY = min(30, 0) = 0.
    expect(computeStickyPlacement(elements)).toEqual({
      x: 100 + STICKY_PLACEMENT_MARGIN,
      y: 0,
    })
  })
})
