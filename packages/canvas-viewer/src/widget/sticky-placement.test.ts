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

  it('accounts for a rotated element by using its rotated AABB, not its unrotated x+width', () => {
    // A tall, narrow element (20 wide, 100 tall) rotated 90 degrees around its
    // own center: its visible footprint becomes 100 wide, 20 tall, centered
    // on the same point as the unrotated rect. Using the raw x+width here
    // would place the sticky note well inside the element's actual (rotated)
    // right edge instead of clear of it.
    const elements = [{ id: 'rotated', x: 0, y: 0, width: 20, height: 100, angle: Math.PI / 2 }]
    // Center = (10, 50). Rotated AABB: x in [10-50, 10+50] = [-40, 60],
    // y in [50-10, 50+10] = [40, 60]. So maxX = 60, minY = 40.
    expect(computeStickyPlacement(elements)).toEqual({
      x: 60 + STICKY_PLACEMENT_MARGIN,
      y: 40,
    })
  })

  it('treats a missing or non-numeric angle as unrotated (angle 0)', () => {
    const elements = [
      { id: 'no-angle', x: 0, y: 0, width: 100, height: 50 },
      { id: 'nan-angle', x: 200, y: 0, width: 10, height: 10, angle: Number.NaN },
    ]
    expect(computeStickyPlacement(elements)).toEqual({
      x: 210 + STICKY_PLACEMENT_MARGIN,
      y: 0,
    })
  })
})
