import { describe, expect } from 'vitest'
import { fc, fcTest, withDefaults } from '../../test-utils/fast-check.js'
import { routeOnGrid } from './grid-route.js'

/**
 * `routeOnGrid` searches the Hanan grid with A*, so its speed comes precisely
 * from NOT expanding states a plain Dijkstra would. That is sound only while
 * the heuristic stays admissible — and an inadmissible one does not throw or
 * return nothing, it quietly returns a path that is merely good. The routing
 * scoreboard cannot catch that either: a slightly-long detour still avoids
 * every body, so every debt metric it pins stays put.
 *
 * So the guard is an independent oracle. This test carries its own plain
 * Dijkstra over the same grid and the same cost model, written from the
 * definition rather than shared with the implementation, and asserts the two
 * agree on COST. Not on the path: equal-cost routes are common on a lattice
 * and which one a search finds is an artifact of its exploration order — the
 * measured reason A* and Dijkstra disagree on ~10-30% of paths while never
 * disagreeing on what an optimal route costs.
 */

const BEND_COST_PX = 80
const CLEARANCE = 16

type Rect = { x: number; y: number; w: number; h: number }
type Point = { x: number; y: number }

/**
 * The reference: Dijkstra over the same Hanan grid, no heuristic, written
 * straight from "cheapest rectilinear path whose interior avoids every rect".
 * Deliberately naive — an O(V^2) scan for the minimum instead of a heap — so
 * it shares no machinery with the thing it is checking.
 */
function referenceCost(
  start: Point,
  end: Point,
  obstacles: readonly Rect[],
  clearance: number,
  windowPx: number,
): number | undefined {
  const minX = Math.min(start.x, end.x) - windowPx
  const maxX = Math.max(start.x, end.x) + windowPx
  const minY = Math.min(start.y, end.y) - windowPx
  const maxY = Math.max(start.y, end.y) + windowPx
  const near = obstacles.filter(
    (r) =>
      r.x - clearance <= maxX &&
      r.x + r.w + clearance >= minX &&
      r.y - clearance <= maxY &&
      r.y + r.h + clearance >= minY,
  )
  const xSet = new Set<number>([start.x, end.x])
  const ySet = new Set<number>([start.y, end.y])
  for (const r of near) {
    for (const x of [r.x - clearance, r.x + r.w + clearance])
      if (x >= minX && x <= maxX) xSet.add(x)
    for (const y of [r.y - clearance, r.y + r.h + clearance])
      if (y >= minY && y <= maxY) ySet.add(y)
  }
  const xs = [...xSet].sort((a, b) => a - b)
  const ys = [...ySet].sort((a, b) => a - b)
  const si = xs.indexOf(start.x)
  const sj = ys.indexOf(start.y)
  const ei = xs.indexOf(end.x)
  const ej = ys.indexOf(end.y)
  if (si < 0 || sj < 0 || ei < 0 || ej < 0) return undefined

  const stateOf = (i: number, j: number, axis: number) => (j * xs.length + i) * 2 + axis
  const best = new Map<number, number>()
  const done = new Set<number>()
  for (const axis of [0, 1]) best.set(stateOf(si, sj, axis), 0)

  for (;;) {
    let cur = -1
    let curCost = Number.POSITIVE_INFINITY
    for (const [state, cost] of best) {
      if (done.has(state)) continue
      if (cost < curCost) {
        curCost = cost
        cur = state
      }
    }
    if (cur < 0) break
    done.add(cur)
    const axis = cur % 2
    const cell = (cur - axis) / 2
    const i = cell % xs.length
    const j = (cell - i) / xs.length
    if (i === ei && j === ej) return curCost
    for (const [di, dj, nextAxis] of [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 1],
      [0, -1, 1],
    ] as const) {
      const ni = i + di
      const nj = j + dj
      if (ni < 0 || nj < 0 || ni >= xs.length || nj >= ys.length) continue
      const horizontal = dj === 0
      const from = (horizontal ? xs[i] : ys[j]) as number
      const to = (horizontal ? xs[ni] : ys[nj]) as number
      const lo = Math.min(from, to)
      const hi = Math.max(from, to)
      const line = (horizontal ? ys[j] : xs[i]) as number
      const lowOf = (r: Rect) => (horizontal ? r.y : r.x)
      const sizeOf = (r: Rect) => (horizontal ? r.h : r.w)
      const acrossLow = (r: Rect) => (horizontal ? r.x : r.y)
      const acrossSize = (r: Rect) => (horizontal ? r.w : r.h)
      // Clearance shapes the GRID COORDINATES and nothing else: blocking and
      // border-tracing are both judged against the rect's raw bounds, because
      // a route riding the offset line is already at the intended distance.
      // Applying clearance twice is the obvious way to write this reference
      // wrong, and it reports the implementation as broken rather than itself.
      if (
        near.some(
          (r) =>
            line > lowOf(r) &&
            line < lowOf(r) + sizeOf(r) &&
            lo < acrossLow(r) + acrossSize(r) &&
            hi > acrossLow(r),
        )
      ) {
        continue
      }
      let traced = 0
      for (const r of near) {
        if (line !== lowOf(r) && line !== lowOf(r) + sizeOf(r)) continue
        const overlapLo = Math.max(lo, acrossLow(r))
        const overlapHi = Math.min(hi, acrossLow(r) + acrossSize(r))
        if (overlapHi > overlapLo) traced += overlapHi - overlapLo
      }
      const turn = (axis === 0) === (nextAxis === 0) ? 0 : BEND_COST_PX
      const next = curCost + (hi - lo) + turn + traced
      const nextState = stateOf(ni, nj, nextAxis)
      if (next < (best.get(nextState) ?? Number.POSITIVE_INFINITY)) best.set(nextState, next)
    }
  }
  return undefined
}

/** The router's own cost of a returned path, measured from the path alone. */
function pathCost(path: readonly Point[], obstacles: readonly Rect[]): number {
  let cost = 0
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] as Point
    const b = path[i] as Point
    const horizontal = a.y === b.y
    const lo = horizontal ? Math.min(a.x, b.x) : Math.min(a.y, b.y)
    const hi = horizontal ? Math.max(a.x, b.x) : Math.max(a.y, b.y)
    const line = horizontal ? a.y : a.x
    cost += hi - lo
    for (const r of obstacles) {
      const lowOf = horizontal ? r.y : r.x
      const sizeOf = horizontal ? r.h : r.w
      if (line !== lowOf && line !== lowOf + sizeOf) continue
      const acrossLow = horizontal ? r.x : r.y
      const acrossSize = horizontal ? r.w : r.h
      const overlapLo = Math.max(lo, acrossLow)
      const overlapHi = Math.min(hi, acrossLow + acrossSize)
      if (overlapHi > overlapLo) cost += overlapHi - overlapLo
    }
  }
  // A collapsed path reports the bends its own turns imply.
  for (let i = 2; i < path.length; i++) {
    const a = path[i - 2] as Point
    const b = path[i - 1] as Point
    const c = path[i] as Point
    if ((a.y === b.y) !== (b.y === c.y)) cost += BEND_COST_PX
  }
  return cost
}

// A LATTICE, not scattered rectangles: identical boxes on a regular pitch is
// what makes equal-cost alternatives common, and a generator too sparse to
// reach them would pass while proving nothing about the case that matters.
const lattice = fc
  .record({
    pitchX: fc.integer({ min: 180, max: 300 }),
    pitchY: fc.integer({ min: 140, max: 220 }),
    w: fc.integer({ min: 80, max: 160 }),
    h: fc.integer({ min: 60, max: 120 }),
    cols: fc.integer({ min: 2, max: 4 }),
    rows: fc.integer({ min: 2, max: 4 }),
    present: fc.array(fc.boolean(), { minLength: 16, maxLength: 16 }),
    startCell: fc.integer({ min: 0, max: 15 }),
    endCell: fc.integer({ min: 0, max: 15 }),
    startSide: fc.integer({ min: 0, max: 3 }),
    endSide: fc.integer({ min: 0, max: 3 }),
  })
  .map((c) => {
    const obstacles: Rect[] = []
    for (let i = 0; i < c.cols; i++) {
      for (let j = 0; j < c.rows; j++) {
        if (c.present[j * c.cols + i] === false) continue
        obstacles.push({ x: i * c.pitchX, y: j * c.pitchY, w: c.w, h: c.h })
      }
    }
    const anchor = (cellIndex: number, side: number): Point => {
      const i = cellIndex % c.cols
      const j = Math.floor(cellIndex / c.cols) % c.rows
      const bx = i * c.pitchX
      const by = j * c.pitchY
      return side === 0
        ? { x: bx + c.w / 2, y: by }
        : side === 1
          ? { x: bx + c.w, y: by + c.h / 2 }
          : side === 2
            ? { x: bx + c.w / 2, y: by + c.h }
            : { x: bx, y: by + c.h / 2 }
    }
    return {
      obstacles,
      start: anchor(c.startCell, c.startSide),
      end: anchor(c.endCell, c.endSide),
    }
  })
  .filter(
    ({ obstacles, start, end }) => obstacles.length > 0 && (start.x !== end.x || start.y !== end.y),
  )

describe('routeOnGrid is optimal, not merely good', () => {
  fcTest.prop({ layout: lattice }, withDefaults({ numRuns: 150 }))(
    'a returned path costs exactly what an independent Dijkstra says it should',
    ({ layout }) => {
      const path = routeOnGrid(layout.start, layout.end, layout.obstacles, CLEARANCE)
      if (path === undefined) return
      const reference = referenceCost(
        layout.start,
        layout.end,
        layout.obstacles,
        CLEARANCE,
        // The implementation's own window; a reference searching a wider one
        // could find routes it is not asking for.
        160,
      )
      expect(reference).toBeDefined()
      expect(pathCost(path, layout.obstacles)).toBeCloseTo(reference as number, 6)
    },
  )
})
