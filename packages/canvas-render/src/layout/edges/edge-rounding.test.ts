import { describe, expect, it } from 'vitest'
import { flattenRoundedEdgePath, roundedEdgeCorners } from './edge-rounding.js'

const right = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
]

describe('roundedEdgeCorners', () => {
  it('yields no corners for a two-point path', () => {
    expect(
      roundedEdgeCorners([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ]),
    ).toEqual([])
  })

  it('decomposes each interior vertex into enter-midpoint, control, leave-midpoint', () => {
    expect(roundedEdgeCorners(right)).toEqual([
      { enter: { x: 50, y: 0 }, control: { x: 100, y: 0 }, leave: { x: 100, y: 50 } },
    ])
  })
})

describe('flattenRoundedEdgePath', () => {
  it('returns a straight path unchanged', () => {
    const straight = [
      { x: 0, y: 0 },
      { x: 10, y: 20 },
    ]
    expect(flattenRoundedEdgePath(straight)).toEqual(straight)
  })

  it('preserves both endpoints', () => {
    const flat = flattenRoundedEdgePath(right)
    expect(flat[0]).toEqual({ x: 0, y: 0 })
    expect(flat.at(-1)).toEqual({ x: 100, y: 100 })
  })

  it('passes through the curve apex, not the sharp corner', () => {
    const flat = flattenRoundedEdgePath(right)
    // Q(0.5) of (50,0)-(100,0)-(100,50) — the drawn curve's apex.
    expect(flat).toContainEqual({ x: 87.5, y: 12.5 })
    expect(flat).not.toContainEqual({ x: 100, y: 0 })
  })

  it('never leaves the bounds of the waypoint polyline', () => {
    const flat = flattenRoundedEdgePath(right)
    for (const p of flat) {
      expect(p.x).toBeGreaterThanOrEqual(0)
      expect(p.x).toBeLessThanOrEqual(100)
      expect(p.y).toBeGreaterThanOrEqual(0)
      expect(p.y).toBeLessThanOrEqual(100)
    }
  })
})
