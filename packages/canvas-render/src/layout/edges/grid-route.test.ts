// The fallback search only runs where the enumerated candidates already
// failed, so nothing else in the suite exercises it. These are its own
// checks: the shapes it must produce, and the two ways it is allowed to
// give up.
import { describe, expect, it } from 'vitest'
import { routeOnGrid } from './grid-route.js'

const rect = (x: number, y: number, w: number, h: number) => ({ x, y, w, h })

describe('routeOnGrid', () => {
  it('runs straight when nothing is in the way', () => {
    expect(routeOnGrid({ x: 0, y: 0 }, { x: 100, y: 0 }, [], 16)).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ])
  })

  it('steps around a box that blocks the straight run', () => {
    const path = routeOnGrid({ x: 0, y: 50 }, { x: 200, y: 50 }, [rect(80, 0, 40, 100)], 16)
    expect(path?.[0]).toEqual({ x: 0, y: 50 })
    expect(path?.[path.length - 1]).toEqual({ x: 200, y: 50 })
    // Nothing may run through the box's strict interior.
    for (let i = 1; i < (path?.length ?? 0); i++) {
      const a = path?.[i - 1] as { x: number; y: number }
      const b = path?.[i] as { x: number; y: number }
      const horizontal = a.y === b.y
      const crosses = horizontal
        ? a.y > 0 && a.y < 100 && Math.min(a.x, b.x) < 120 && Math.max(a.x, b.x) > 80
        : a.x > 80 && a.x < 120 && Math.min(a.y, b.y) < 100 && Math.max(a.y, b.y) > 0
      expect(crosses).toBe(false)
    }
  })

  it('keeps the requested clearance from the obstacle it passes', () => {
    const path = routeOnGrid({ x: 0, y: 50 }, { x: 200, y: 50 }, [rect(80, 0, 40, 100)], 16)
    // The only ways past are the channels 16px above and below the box.
    expect(path?.some((p) => p.y === -16 || p.y === 116)).toBe(true)
  })

  it('collapses collinear points', () => {
    const path = routeOnGrid({ x: 0, y: 0 }, { x: 300, y: 0 }, [rect(500, 500, 10, 10)], 16)
    expect(path).toEqual([
      { x: 0, y: 0 },
      { x: 300, y: 0 },
    ])
  })

  it('gives up rather than search a dense canvas', () => {
    // 40 obstacles put the grid past MAX_GRID_CELLS; the caller keeps its
    // enumerated candidate instead of paying for this.
    const many = Array.from({ length: 40 }, (_, i) => rect(i * 50, i * 30, 20, 20))
    expect(routeOnGrid({ x: -100, y: -100 }, { x: 3000, y: 2000 }, many, 16)).toBeUndefined()
  })

  it('returns undefined when the target is walled in', () => {
    const walls = [
      rect(90, 40, 20, 120),
      rect(190, 40, 20, 120),
      rect(90, 40, 120, 20),
      rect(90, 140, 120, 20),
    ]
    expect(routeOnGrid({ x: 0, y: 100 }, { x: 150, y: 100 }, walls, 16)).toBeUndefined()
  })
})
