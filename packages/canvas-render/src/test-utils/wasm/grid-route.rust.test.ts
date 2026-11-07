import { afterAllFloor } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect } from 'vitest'
import type { Point, Rect } from '../../layout/edges/edge-geometry.js'
import { routeOnGrid as routeTs } from '../../layout/edges/grid-route.js'
import { fc, fcTest, withDefaults } from '../fast-check.js'
import { built } from './glue.js'
import { routeOnGrid as routeRust } from './grid-route.js'

/**
 * `routeOnGrid` against its Rust port through the wasm artifact (ADR-0054,
 * QR-21 layer 2). The layer-1 suites judge the Rust router by the TypeScript's
 * own examples, which say nothing about an input none of them draws; this
 * compares the two on the same draw, path and spent budget, every coordinate
 * by `Object.is` so a signed zero counts.
 *
 * The TypeScript is imported by a path the project's `./grid-route.js` alias
 * does not match, so this is never the Rust against itself.
 */

/** A lattice coordinate, so obstacles share lines and ties are common, plus the doubles JS treats specially. */
const coordinate = fc.oneof(
  { weight: 8, arbitrary: fc.integer({ min: -6, max: 12 }).map((k) => k * 20) },
  { weight: 1, arbitrary: fc.constantFrom(-0, Number.NaN, Number.POSITIVE_INFINITY, -1e-300) },
)
const size = fc.oneof(
  { weight: 8, arbitrary: fc.integer({ min: 1, max: 6 }).map((k) => k * 20) },
  { weight: 1, arbitrary: fc.constantFrom(0, -0, -20, Number.NaN) },
)
const point = fc.record({ x: coordinate, y: coordinate })
const rect = fc.record({ x: coordinate, y: coordinate, w: size, h: size })
const query = fc.record({
  start: point,
  end: point,
  obstacles: fc.array(rect, { maxLength: 8 }),
  clearance: fc.oneof(fc.constantFrom(0, 8, 16, -0, Number.NaN), fc.double({ min: 0, max: 40 })),
  allowance: fc.oneof(
    fc.constant(Number.POSITIVE_INFINITY),
    fc.integer({ min: 0, max: 400 }),
    fc.integer({ min: 0, max: 20_000 }),
  ),
})

const reach = { routed: 0, refused: 0, signedZero: 0 }

/** A point as text that keeps a signed zero, which `JSON.stringify` prints as `0`. */
const show = (p: Point | undefined) =>
  p === undefined
    ? 'none'
    : `(${[p.x, p.y].map((v) => (Object.is(v, -0) ? '-0' : String(v))).join(', ')})`

/** The first coordinate where the two paths differ, or undefined when they are the same path. */
function firstDifference(ts: Point[] | undefined, rust: Point[] | undefined): string | undefined {
  if (ts === undefined || rust === undefined)
    return ts === rust ? undefined : `ts ${ts === undefined ? 'refused' : 'routed'}, rust not`
  if (ts.length !== rust.length) return `length ${ts.length} vs ${rust.length}`
  const at = ts.findIndex((p, i) => !Object.is(p.x, rust[i]?.x) || !Object.is(p.y, rust[i]?.y))
  return at === -1 ? undefined : `point ${at}: ts ${show(ts[at])}, rust ${show(rust[at])}`
}

describe.runIf(built)('grid-route.ts and its Rust port answer the same route', () => {
  fcTest.prop([query], withDefaults())('path and spent budget', (q) => {
    const tsBudget = { grid: q.allowance }
    const rustBudget = { grid: q.allowance }
    const obstacles: Rect[] = q.obstacles
    const ts = routeTs(q.start, q.end, obstacles, q.clearance, tsBudget)
    const rust = routeRust(q.start, q.end, obstacles, q.clearance, rustBudget)
    if (ts === undefined) reach.refused += 1
    else reach.routed += 1
    if (ts?.some((p) => p.x === 0 || p.y === 0)) reach.signedZero += 1
    expect(firstDifference(ts, rust)).toBeUndefined()
    expect(Object.is(rustBudget.grid, tsBudget.grid)).toBe(true)
  })

  afterAllFloor(['path and spent budget'], () => {
    // Both outcomes are drawn, and routes through a zero line (where a -0
    // input can surface) are drawn often enough to matter. Floors at about
    // half of what three runs measured.
    expect(reach.routed).toBeGreaterThan(20)
    expect(reach.refused).toBeGreaterThan(10)
    expect(reach.signedZero).toBeGreaterThan(5)
  })
})
