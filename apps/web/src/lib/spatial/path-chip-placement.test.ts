// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { placePathChip } from './path-chip-placement.js'

// A path rising left to right: bounds x 0..100, y 0..100, its end at the top-right.
const points = [
  { x: 0, y: 100 },
  { x: 100, y: 0 },
]
const base = { points, size: 20, gap: 5, handleHalf: 10 }

describe('placePathChip', () => {
  it('sits above the top-right corner when no handle is there', () => {
    expect(placePathChip({ ...base, handles: [] })).toEqual({ x: 80, y: -25 })
  })

  it('moves to the next corner when a handle sits under the home', () => {
    expect(placePathChip({ ...base, handles: [points[1]!, points[0]!] })).toEqual({ x: 0, y: -25 })
  })

  it('prefers a clear place on screen over one off it', () => {
    // Above the path is off screen, so below the bottom-right wins over the
    // clear top-left that would otherwise come first.
    const visible = { x: -50, y: -2, width: 300, height: 300 }
    expect(placePathChip({ ...base, handles: [points[1]!, points[0]!], visible })).toEqual({
      x: 80,
      y: 105,
    })
  })

  it('rises clear of every handle when every corner is taken', () => {
    const everywhere = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 0, y: 100 },
      { x: 100, y: 100 },
    ]
    const corner = placePathChip({ ...base, handles: everywhere })
    expect(corner).toEqual({ x: 80, y: -35 })
  })

  it('answers nothing without a path to place by', () => {
    expect(placePathChip({ ...base, points: [{ x: 0, y: 0 }], handles: [] })).toBeUndefined()
  })
})
