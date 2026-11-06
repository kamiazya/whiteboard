import { afterAllFloor } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect } from 'vitest'
import { fc, fcTest, withDefaults } from '../../test-utils/fast-check.js'
import { DETOUR_REACH_PX } from './edge-router.js'
import { cornerDetour, type DetourObstacle } from './straight-detour.js'

/**
 * What the corner search promises whatever the board: a route it returns
 * crosses nothing it was told to avoid, and turns only within the reach the
 * router's obstacle prune assumes. The leg test is written here from the
 * definition (a Liang-Barsky clip against the open rect), not borrowed from
 * the router, so a broken clearance test cannot agree with itself.
 */
type P = { x: number; y: number }
type R = { x: number; y: number; w: number; h: number }

/**
 * Whether `a`->`b` runs through the inside of `r` for some length. Touching
 * its boundary — a corner, or a run along a side — is not entering it: a
 * block is a margin band, and grazing the band's edge still clears the body.
 */
function meets(a: P, b: P, r: R): boolean {
  const dx = b.x - a.x
  const dy = b.y - a.y
  let t0 = 0
  let t1 = 1
  for (const [p, q] of [
    [-dx, a.x - r.x],
    [dx, r.x + r.w - a.x],
    [-dy, a.y - r.y],
    [dy, r.y + r.h - a.y],
  ] as const) {
    if (p === 0) {
      if (q <= 0) return false
      continue
    }
    const t = q / p
    if (p < 0) t0 = Math.max(t0, t)
    else t1 = Math.min(t1, t)
    if (t0 >= t1) return false
  }
  return true
}

const inside = (r: R, p: P) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h

const MARGIN = 8

// Dense on purpose: boxes up to a third of the field, so most draws put
// several in the line's way and some overlap.
const box = fc.record({
  x: fc.integer({ min: 0, max: 500 }),
  y: fc.integer({ min: 0, max: 500 }),
  w: fc.integer({ min: 10, max: 200 }),
  h: fc.integer({ min: 10, max: 200 }),
})
const point = fc.record({
  x: fc.integer({ min: -50, max: 650 }),
  y: fc.integer({ min: -50, max: 650 }),
})

const obstaclesOf = (bodies: readonly R[]): DetourObstacle[] =>
  bodies.map((body) => ({
    body,
    block: {
      x: body.x - MARGIN,
      y: body.y - MARGIN,
      w: body.w + 2 * MARGIN,
      h: body.h + 2 * MARGIN,
    },
    escapable: true,
  }))

let detoured = 0

describe('a corner detour', () => {
  fcTest.prop(
    { start: point, end: point, bodies: fc.array(box, { minLength: 1, maxLength: 8 }) },
    withDefaults({ numRuns: 400 }),
  )('crosses nothing and turns within the prune reach', ({ start, end, bodies }) => {
    // An end inside a body cannot be routed around; the router drops such a
    // body from the obstacles before asking.
    const free = bodies.filter((b) => !inside(b, start) && !inside(b, end))
    const obstacles = obstaclesOf(free)
    const path = cornerDetour(start, end, obstacles, DETOUR_REACH_PX)
    if (path === undefined) return
    expect(path[0]).toEqual(start)
    expect(path[path.length - 1]).toEqual(end)
    if (path.length > 2) detoured++
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1] as P
      const b = path[i] as P
      for (const o of obstacles) {
        const escaping = inside(o.block, a) || inside(o.block, b)
        expect(meets(a, b, escaping ? o.body : o.block)).toBe(false)
      }
    }
    for (const turn of path.slice(1, -1)) {
      const near = free.some(
        (b) =>
          turn.x >= b.x - DETOUR_REACH_PX &&
          turn.x <= b.x + b.w + DETOUR_REACH_PX &&
          turn.y >= b.y - DETOUR_REACH_PX &&
          turn.y <= b.y + b.h + DETOUR_REACH_PX,
      )
      expect(near).toBe(true)
    }
  })

  afterAllFloor(['crosses nothing and turns within the prune reach'], () => {
    // Vacuous if the generator rarely puts a box in the line's way;
    // measured 129 detours in 400 draws.
    expect(detoured).toBeGreaterThan(40)
  })
})
