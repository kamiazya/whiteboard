// `grid-route`'s scoreboard, and the hole it plugs.
//
// The optimality property beside this file is a genuine independent oracle —
// an own Dijkstra, agreeing on cost to six places. It also opens with
// `if (path === undefined) return`, so a change that simply stops FINDING
// routes satisfies it in full: there is nothing to disagree with. Measured,
// 134 of this module's mutants survived a suite containing that property.
//
// A count is what closes it. `routesFound` and `routesAbandoned` are pinned
// EXACTLY, so a search that gives up more often is as loud as one that gives
// up less, and the debt metrics below state the contract the docstring makes
// — a path avoids the bodies, is rectilinear, ends where it was asked to, and
// carries no collinear filler.
//
// It lives in the mutation lane, unlike `edge-routing-quality.test.ts`: that
// one scores the whole layout pipeline over 2000 layouts and costs ~22s, which
// Stryker would pay once per mutant. This one calls `routeOnGrid` directly.
import { describe, expect, it } from 'vitest'
import { fc } from '../../test-utils/fast-check.js'
import type { Point, Rect } from './edge-rules.js'
import { routeOnGrid } from './grid-route.js'

const CLEARANCE = 12
const CORPUS_SEED = 90210
const CORPUS_SIZE = 200

/**
 * A lattice of boxes with the endpoints on two of their borders — the
 * arrangement this search exists for, since its whole reason to exist is
 * threading BETWEEN obstacles. Endpoints on borders rather than in open space
 * because that is where anchors actually sit.
 */
const latticeArb = fc
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
      if (side === 0) return { x: bx + c.w / 2, y: by }
      if (side === 1) return { x: bx + c.w, y: by + c.h / 2 }
      if (side === 2) return { x: bx + c.w / 2, y: by + c.h }
      return { x: bx, y: by + c.h / 2 }
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

const CORPUS = fc.sample(latticeArb, { numRuns: CORPUS_SIZE, seed: CORPUS_SEED })

/** Whether a segment puts ink strictly inside a rect. Computed here from
 * geometry, never by asking the module under test. */
function crossesInterior(a: Point, b: Point, r: Rect): boolean {
  const loX = Math.min(a.x, b.x)
  const hiX = Math.max(a.x, b.x)
  const loY = Math.min(a.y, b.y)
  const hiY = Math.max(a.y, b.y)
  return loX < r.x + r.w && hiX > r.x && loY < r.y + r.h && hiY > r.y
}

const manhattan = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)

describe('grid-route quality scoreboard', () => {
  it('is measured against a corpus that actually obstructs', () => {
    // A guard on the instrument: a corpus whose straight runs are all clear
    // would score perfectly for a search that never has to do anything.
    const blocked = CORPUS.filter(({ start, end, obstacles }) =>
      obstacles.some((r) => crossesInterior(start, end, r)),
    )

    expect(CORPUS).toHaveLength(CORPUS_SIZE)
    expect(blocked.length).toBeGreaterThan(CORPUS_SIZE / 4)
  })

  it('scores the corpus', () => {
    let routesFound = 0
    let routesAbandoned = 0
    let interiorHits = 0
    let nonRectilinear = 0
    let collinearLeft = 0
    let wrongEndpoints = 0
    let totalLength = 0
    let totalBends = 0

    for (const { start, end, obstacles } of CORPUS) {
      const path = routeOnGrid(start, end, obstacles, CLEARANCE)
      if (path === undefined) {
        routesAbandoned++
        continue
      }
      routesFound++

      const first = path[0] as Point
      const last = path.at(-1) as Point
      if (first.x !== start.x || first.y !== start.y || last.x !== end.x || last.y !== end.y) {
        wrongEndpoints++
      }
      for (let i = 1; i < path.length; i++) {
        const a = path[i - 1] as Point
        const b = path[i] as Point
        if (a.x !== b.x && a.y !== b.y) nonRectilinear++
        totalLength += manhattan(a, b)
        // The endpoints sit ON a border, so their own two bodies are the ones
        // a path is allowed to touch — every other body it must go around.
        for (const r of obstacles) {
          const ownsAnEnd =
            (start.x >= r.x && start.x <= r.x + r.w && start.y >= r.y && start.y <= r.y + r.h) ||
            (end.x >= r.x && end.x <= r.x + r.w && end.y >= r.y && end.y <= r.y + r.h)
          if (!ownsAnEnd && crossesInterior(a, b, r)) interiorHits++
        }
      }
      for (let i = 2; i < path.length; i++) {
        const a = path[i - 2] as Point
        const b = path[i - 1] as Point
        const c = path[i] as Point
        if ((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y)) collinearLeft++
        else totalBends++
      }
    }

    expect({
      interiorHits,
      nonRectilinear,
      collinearLeft,
      wrongEndpoints,
      routesFound,
      routesAbandoned,
      totalLength,
      totalBends,
    }).toEqual({
      // DEBT — the contract `routeOnGrid`'s docstring states.
      interiorHits: 0,
      nonRectilinear: 0,
      collinearLeft: 0,
      wrongEndpoints: 0,
      // PRICE — no target. `routesFound`/`routesAbandoned` are the pair the
      // optimality property structurally cannot see, because it returns early
      // on exactly the case they count. Every board in this corpus is
      // routable today; the zero is the point, not an absence of coverage.
      routesFound: 200,
      routesAbandoned: 0,
      totalLength: 83086,
      totalBends: 250,
    })
  })
})
