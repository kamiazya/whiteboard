import { afterAllFloor } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect } from 'vitest'
import { diagonalInkThrough } from '../../layout/edges/diagonal-ink.js'
import {
  boundingBoxOf,
  midpointExtent,
  type Point,
  pathIsClear,
  pathLength,
  type Rect,
  segmentCrossesRect,
  unionRect,
  withoutRepeats,
} from '../../layout/edges/edge-geometry.js'
import {
  inkAlongRects,
  quantize,
  selfRetracedInk,
  tunnelledInk,
} from '../../layout/edges/edge-ink.js'
import { flattenRoundedEdgePath } from '../../layout/edges/edge-rounding.js'
import { segmentIntersection } from '../../layout/edges/segment-intersection.js'
import { fc, fcTest, withDefaults } from '../fast-check.js'
import { built, wasm } from './glue.js'

/**
 * The edge layer's geometry and ink primitives against their Rust port
 * through the wasm artifact (ADR-0054 step 5, QR-21 layer 2): edge-geometry,
 * segment-intersection, edge-ink, diagonal-ink and edge-rounding. Each side
 * computes its own answer from the same draw, and every number is compared
 * exactly, a signed zero included.
 */

/** Equal as doubles, NaN equal to NaN (a payload does not survive a typed array), a signed zero counted. */
const sameDouble = (a: number, b: number) =>
  Number.isNaN(a) || Number.isNaN(b) ? Number.isNaN(a) && Number.isNaN(b) : Object.is(a, b)

/** The first index the two answers differ at, for a minimal repro. */
function firstDifference(ts: readonly number[], rust: Float64Array): string | undefined {
  const at = ts.findIndex((v, i) => !sameDouble(v, rust[i] ?? Number.NaN))
  if (at === -1 && ts.length === rust.length) return undefined
  const i = at === -1 ? Math.min(ts.length, rust.length) : at
  const show = (v: number | undefined) => (Object.is(v, -0) ? '-0' : String(v))
  return `index ${i}: ts ${show(ts[i])}, rust ${show(rust[i])} (lengths ${ts.length}, ${rust.length})`
}

/**
 * Coordinates on a quarter-pixel lattice, so paths run along each other and
 * along borders (where the ink terms are non-zero) and land on the half
 * quanta `quantize` rounds, plus the doubles JavaScript treats specially.
 */
const coordinate = fc.oneof(
  { weight: 10, arbitrary: fc.integer({ min: -40, max: 80 }).map((k) => k * 2.5) },
  { weight: 2, arbitrary: fc.integer({ min: -400, max: 800 }).map((k) => k / 8) },
  { weight: 1, arbitrary: fc.double({ min: -200, max: 200 }) },
  { weight: 1, arbitrary: fc.constantFrom(-0, Number.NaN, Number.POSITIVE_INFINITY, -1e300) },
)
const size = fc.oneof(
  { weight: 8, arbitrary: fc.integer({ min: 1, max: 24 }).map((k) => k * 2.5) },
  { weight: 1, arbitrary: fc.constantFrom(0, -0, -10, Number.NaN) },
)
const point = fc.record({ x: coordinate, y: coordinate })
const rect = fc.record({ x: coordinate, y: coordinate, w: size, h: size })

/** A path that mostly turns at right angles, as a routed edge does, sometimes cutting a diagonal. */
const path = fc
  .tuple(
    point,
    fc.array(
      fc.tuple(fc.constantFrom('h', 'v', 'h', 'v', 'diagonal', 'repeat'), coordinate, coordinate),
      { maxLength: 7 },
    ),
  )
  .map(([start, steps]) => {
    const points: Point[] = [start]
    for (const [kind, a, b] of steps) {
      const last = points.at(-1) as Point
      if (kind === 'h') points.push({ x: a, y: last.y })
      else if (kind === 'v') points.push({ x: last.x, y: a })
      else if (kind === 'repeat') points.push({ ...last })
      else points.push({ x: a, y: b })
    }
    return points
  })

/**
 * Rects drawn AGAINST a path as well as anywhere: a corner on one of its
 * points (so a segment runs along that rect's border), or centred on a
 * segment's midpoint (so the segment, diagonal or not, runs through it).
 * Placed anywhere, a rect almost never shares a line with a path, and the
 * border and diagonal terms would be compared on zeros.
 */
const pathAndRects = path.chain((p) => {
  const anchored = fc
    .tuple(fc.nat(p.length - 1), size, size, fc.constantFrom('corner', 'far-corner', 'midpoint'))
    .map(([i, w, h, kind]): Rect => {
      const a = p[i] as Point
      const b = p[Math.min(i + 1, p.length - 1)] as Point
      if (kind === 'corner') return { x: a.x, y: a.y, w, h }
      if (kind === 'far-corner') return { x: a.x - w, y: a.y - h, w, h }
      return { x: (a.x + b.x) / 2 - w / 2, y: (a.y + b.y) / 2 - h / 2, w, h }
    })
  return fc.tuple(fc.constant(p), fc.array(fc.oneof(rect, anchored, anchored), { maxLength: 5 }))
})

/**
 * A segment-test case, its second segment sometimes STARTING on the first
 * (at its midpoint or an end) so the intersection's open-interval tests
 * meet the exact zero they exclude; two free segments almost never do.
 */
const segmentCase = fc
  .tuple(
    point,
    point,
    rect,
    point,
    point,
    fc.constantFrom('free', 'free', 'from-midpoint', 'from-end'),
  )
  .map(([a, b, r, c, d, kind]): [Point, Point, Rect, Point, Point] => {
    if (kind === 'from-midpoint') return [a, b, r, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, d]
    if (kind === 'from-end') return [a, b, r, a, d]
    return [a, b, r, c, d]
  })

const reach = {
  borderInk: 0,
  strictInk: 0,
  tunnelled: 0,
  retraced: 0,
  diagonal: 0,
  blocked: 0,
  crosses: 0,
  hits: 0,
}

const flat = (points: readonly Point[]) => [points.length, ...points.flatMap((p) => [p.x, p.y])]
const rectValues = (r: Rect | undefined) =>
  r === undefined ? [Number.NaN, Number.NaN, Number.NaN, Number.NaN] : [r.x, r.y, r.w, r.h]

/** The TypeScript's answers in the order `edge_path_measures` writes its own. */
function tsMeasures(p: readonly Point[], rects: readonly Rect[]): number[] {
  const borderInk = inkAlongRects(p, rects, (fixed, near, far) => fixed === near || fixed === far)
  const strictInk = inkAlongRects(p, rects, (fixed, near, far) => near < fixed && fixed < far)
  const extent = midpointExtent(p)
  const answers = [
    pathLength(p),
    borderInk,
    strictInk,
    tunnelledInk(p, rects),
    selfRetracedInk(p),
    diagonalInkThrough(p, rects),
    pathIsClear(p, rects) ? 1 : 0,
    ...rectValues(unionRect(rects)),
    ...rectValues(boundingBoxOf(p)),
    extent.spanX,
    extent.spanY,
    extent.originX,
    extent.originY,
    ...flat(withoutRepeats(p)),
    ...flat(flattenRoundedEdgePath(p)),
  ]
  if (borderInk > 0) reach.borderInk += 1
  if (strictInk > 0) reach.strictInk += 1
  if ((answers[3] as number) > 0) reach.tunnelled += 1
  if ((answers[4] as number) > 0) reach.retraced += 1
  if ((answers[5] as number) > 0) reach.diagonal += 1
  if (answers[6] === 0) reach.blocked += 1
  return answers
}

describe.runIf(built)('the edge primitives and their Rust port answer the same numbers', () => {
  fcTest.prop([fc.array(coordinate, { minLength: 1, maxLength: 64 })], withDefaults())(
    'quantize',
    (xs) => {
      const rust = wasm?.det_round(Float64Array.from(xs, (x) => x * 4)) ?? new Float64Array()
      expect(firstDifference(xs.map(quantize), rust)).toBeUndefined()
    },
  )

  fcTest.prop([pathAndRects], withDefaults())('path measures', ([p, rects]) => {
    const input = Float64Array.from([
      p.length,
      ...p.flatMap((q) => [q.x, q.y]),
      rects.length,
      ...rects.flatMap((r) => [r.x, r.y, r.w, r.h]),
    ])
    const rust = wasm?.edge_path_measures(input) ?? new Float64Array()
    expect(firstDifference(tsMeasures(p, rects), rust)).toBeUndefined()
  })

  fcTest.prop([fc.array(segmentCase, { minLength: 1, maxLength: 32 })], withDefaults())(
    'segment tests',
    (cases) => {
      const ts = cases.flatMap(([a, b, r, c, d]) => {
        const crosses = segmentCrossesRect(a, b, r)
        const hit = segmentIntersection(a, b, c, d)
        if (crosses) reach.crosses += 1
        if (hit !== undefined) reach.hits += 1
        return [crosses ? 1 : 0, hit?.x ?? Number.NaN, hit?.y ?? Number.NaN]
      })
      const input = Float64Array.from(
        cases.flatMap(([a, b, r, c, d]) => [
          a.x,
          a.y,
          b.x,
          b.y,
          r.x,
          r.y,
          r.w,
          r.h,
          c.x,
          c.y,
          d.x,
          d.y,
        ]),
      )
      expect(
        firstDifference(ts, wasm?.edge_segment_tests(input) ?? new Float64Array()),
      ).toBeUndefined()
    },
  )

  afterAllFloor(['path measures', 'segment tests'], () => {
    // Every term is drawn non-zero often enough that agreement is not
    // agreement on zeros. Floors at about half of what three runs measured.
    expect(reach.borderInk).toBeGreaterThan(30)
    expect(reach.strictInk).toBeGreaterThan(17)
    expect(reach.tunnelled).toBeGreaterThan(20)
    expect(reach.retraced).toBeGreaterThan(28)
    expect(reach.diagonal).toBeGreaterThan(10)
    expect(reach.blocked).toBeGreaterThan(45)
    expect(reach.crosses).toBeGreaterThan(28)
    expect(reach.hits).toBeGreaterThan(80)
  })
})
