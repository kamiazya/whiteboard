import { describe, expect, it } from 'vitest'
import { flattenDrawnEdgePath } from './edge-flatten.js'
import { flattenRoundedEdgePath } from './edge-rounding.js'

describe('flattenDrawnEdgePath', () => {
  it('is the identity without jumps or rounding', () => {
    const path = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ]
    expect(flattenDrawnEdgePath(path)).toEqual(path)
  })

  it('matches flattenRoundedEdgePath for a rounded path without jumps', () => {
    const path = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
    ]
    expect(flattenDrawnEdgePath(path, [], true)).toEqual(flattenRoundedEdgePath(path))
  })

  it('arcs over a jump: apex 5px left of travel, entry/exit on the base line', () => {
    const path = [
      { x: 0, y: 10 },
      { x: 100, y: 10 },
    ]
    const flat = flattenDrawnEdgePath(path, [{ segment: 0, x: 50, y: 10 }])
    // Left of rightward travel in y-down coordinates is upward.
    const apex = flat.find((p) => Math.abs(p.x - 50) < 1e-9)
    expect(apex?.y).toBeCloseTo(5, 9)
    expect(flat.some((p) => p.x === 45 && p.y === 10)).toBe(true)
    expect(flat.some((p) => p.x === 55 && p.y === 10)).toBe(true)
    // No sampled point strays beyond the hop radius from the base line.
    for (const p of flat) {
      expect(p.y).toBeGreaterThanOrEqual(5 - 1e-9)
      expect(p.y).toBeLessThanOrEqual(10 + 1e-9)
    }
  })

  it('drops a hop without arc clearance inside a rounded span, like the backend', () => {
    // The corner truncates the horizontal span to its midpoint (50,0); a
    // jump at x=48 leaves < 5px of clearance to the span end and must be
    // dropped rather than deforming the corner.
    const path = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
    ]
    const kept = flattenDrawnEdgePath(path, [{ segment: 0, x: 30, y: 0 }], true)
    const dropped = flattenDrawnEdgePath(path, [{ segment: 0, x: 48, y: 0 }], true)
    expect(kept.some((p) => p.y < -1e-9)).toBe(true)
    expect(dropped).toEqual(flattenDrawnEdgePath(path, [], true))
  })
})
