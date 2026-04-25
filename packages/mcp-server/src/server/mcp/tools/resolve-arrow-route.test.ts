import { describe, it, expect } from 'vitest'
import { resolveArrowRoute } from './resolve-arrow-route.js'
//

describe('resolveArrowRoute', () => {
  it('case 258', () => {
    const r = resolveArrowRoute({
      start: { x: 0, y: 0 },
      end: { x: 100, y: 50 },
    })
    expect(r.points).toEqual([
      [0, 0],
      [100, 50],
    ])
  })

  it('case 259', () => {
    const r = resolveArrowRoute({
      start: { x: 0, y: 0 },
      end: { x: 100, y: 50 },
      obstacles: [{ x: 200, y: 200, width: 50, height: 50 }],
    })
    expect(r.points).toEqual([
      [0, 0],
      [100, 50],
    ])
  })

  it('case 260', () => {
    const r = resolveArrowRoute({
      start: { x: 0, y: 0 },
      end: { x: 200, y: 200 },
      obstacles: [{ x: 50, y: 50, width: 100, height: 100 }],
    })
    expect(r.points).toHaveLength(3)
    expect(r.points[0]).toEqual([0, 0])
    expect(r.points[2]).toEqual([200, 200])
    const elbow = r.points[1]
    expect(
      (elbow[0] === 200 && elbow[1] === 0) || (elbow[0] === 0 && elbow[1] === 200),
    ).toBe(true)
  })

  it('case 261', () => {
    const r = resolveArrowRoute({
      start: { x: 0, y: 0 },
      end: { x: 200, y: 200 },
      obstacles: [
        { x: 90, y: 90, width: 20, height: 20 }, // A: blocks the straight path
        { x: 50, y: -5, width: 100, height: 10 }, // B: blocks the L1 horizontal edge
      ],
    })
    expect(r.points).toHaveLength(3)
    expect(r.points[1]).toEqual([0, 200])
  })

  it('case 262', () => {
    const r = resolveArrowRoute({
      start: { x: 0, y: 0 },
      end: { x: 200, y: 200 },
      obstacles: [
        { x: 50, y: -10, width: 100, height: 20 }, // Blocks horizontal y=0
        { x: -10, y: 50, width: 20, height: 100 }, // Blocks vertical x=0
        { x: 50, y: 190, width: 100, height: 20 }, // Also blocks horizontal y=200
        { x: 190, y: 50, width: 20, height: 100 }, // Also blocks vertical x=200
      ],
    })
    expect(r.points).toEqual([
      [0, 0],
      [200, 200],
    ])
  })

  it('case 263', () => {
    const r = resolveArrowRoute({
      start: { x: 290, y: 280 },
      end: { x: 200, y: 580 },
      obstacles: [{ x: 40, y: 400, width: 320, height: 60 }],
    })
    expect(r.points.length).toBe(4)
    expect(r.points[0]).toEqual([0, 0])
    expect(r.points[3]).toEqual([200 - 290, 580 - 280]) // [-90, 300]
    const [, [p1x, p1y], [p2x, p2y]] = r.points
    expect(p1y).toBe(0) // Keeps start.y
    expect(p2y).toBe(300) // Reaches end.y
    expect(p1x).toBe(p2x) // The middle vertical segment keeps a fixed x
    expect(p1x).toBeGreaterThan(60) // Clears the obstacle right edge (= rel 70) plus margin
  })

  it('case 264', () => {
    const r = resolveArrowRoute({
      start: { x: 0, y: 0 },
      end: { x: 100, y: 0 },
      obstacles: [{ x: 40, y: -10, width: 20, height: 20 }],
    })
    expect(r.points).toEqual([
      [0, 0],
      [100, 0],
    ])
  })

  it('case 265', () => {
    const r = resolveArrowRoute({
      start: { x: 50, y: 50 },
      end: { x: 50, y: 50 },
    })
    expect(r.points).toEqual([
      [0, 0],
      [0, 0],
    ])
  })
})
