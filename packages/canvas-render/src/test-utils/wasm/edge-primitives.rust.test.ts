import { edgeSideSchema } from '@kamiazya/whiteboard-model'
import { afterAllFloor } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect } from 'vitest'
import { diagonalInkThrough } from '../../layout/edges/diagonal-ink.js'
import {
  boundingBoxOf,
  centerOf,
  containsPoint,
  midpointExtent,
  outwardNormal,
  type Point,
  pathIsClear,
  pathLength,
  type Rect,
  segmentCrossesRect,
  sidePoint,
  sidePointAt,
  strictlyInside,
  tangentCoordinate,
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
import { coordinate, firstDifference, pathAndRects, point, rect } from './edge-arbitraries.js'
import { built, requireWasm } from './glue.js'

/**
 * The edge layer's geometry and ink primitives against their Rust port
 * through the wasm artifact (ADR-0054 step 5, QR-21 layer 2): edge-geometry,
 * segment-intersection, edge-ink, diagonal-ink and edge-rounding. Each side
 * computes its own answer from the same draw, and every number is compared
 * exactly, a signed zero included.
 */

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
    fc.constantFrom(
      'free',
      'free',
      'free',
      'from-midpoint',
      'from-end',
      'near-an-end',
      'overflowing',
    ),
  )
  .map(([a, b, r, c, d, kind]): [Point, Point, Rect, Point, Point] => {
    if (kind === 'from-midpoint') return [a, b, r, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, d]
    if (kind === 'from-end') return [a, b, r, a, d]
    if (kind === 'near-an-end') {
      // A crossing 3px along the first segment, inside the 6px the arc needs.
      const along = 3 / Math.hypot(b.x - a.x, b.y - a.y)
      const mid = { x: a.x + (b.x - a.x) * along, y: a.y + (b.y - a.y) * along }
      const perp = { x: -(b.y - a.y) * 0.1, y: (b.x - a.x) * 0.1 }
      return [
        a,
        b,
        r,
        { x: mid.x + perp.x, y: mid.y + perp.y },
        { x: mid.x - perp.x, y: mid.y - perp.y },
      ]
    }
    if (kind === 'overflowing') {
      // Extents past the double range turn the arithmetic NaN or infinite.
      return [a, { x: b.x * 1e307, y: b.y * 1e307 }, r, c, { x: d.x * -1e307, y: d.y * 1e307 }]
    }
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
  atAnEnd: 0,
  tooNearAnEnd: 0,
  overflowed: 0,
}

/**
 * Why `segmentIntersection` refused a case its segments do cross, read with
 * its own arithmetic: at an end (an open-interval bound met exactly), too
 * near an end for the arc, or an overflowing extent. Reach only; the answer
 * compared is the function's own.
 */
function refusal(a1: Point, a2: Point, b1: Point, b2: Point): keyof typeof reach | undefined {
  const [dax, day, dbx, dby] = [a2.x - a1.x, a2.y - a1.y, b2.x - b1.x, b2.y - b1.y]
  const denom = dax * dby - day * dbx
  if (denom === 0) return undefined
  const t = ((b1.x - a1.x) * dby - (b1.y - a1.y) * dbx) / denom
  const u = ((b1.x - a1.x) * day - (b1.y - a1.y) * dax) / denom
  // The function's own guard: a NaN `t` or `u` passes it, and the finite
  // check after it is what refuses an overflow.
  if (t <= 0 || t >= 1 || u <= 0 || u >= 1) {
    return t === 0 || t === 1 || u === 0 || u === 1 ? 'atAnEnd' : undefined
  }
  const x = a1.x + t * dax
  const y = a1.y + t * day
  return Number.isFinite(x) && Number.isFinite(y) ? 'tooNearAnEnd' : 'overflowed'
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
      const rust = requireWasm().det_round(Float64Array.from(xs, (x) => x * 4))
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
    const rust = requireWasm().edge_path_measures(input)
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
        else {
          const why = refusal(a, b, c, d)
          if (why !== undefined) reach[why] += 1
        }
        const center = centerOf(r)
        return [
          crosses ? 1 : 0,
          hit === undefined ? 0 : 1,
          hit?.x ?? Number.NaN,
          hit?.y ?? Number.NaN,
          containsPoint(r, a) ? 1 : 0,
          strictlyInside(r, a) ? 1 : 0,
          center.x,
          center.y,
          ...edgeSideSchema.options.flatMap((side) => {
            const on = sidePoint(r, side)
            const at = sidePointAt(r, side, c.x)
            const normal = outwardNormal(side)
            return [on.x, on.y, at.x, at.y, tangentCoordinate(side, a), normal.x, normal.y]
          }),
        ]
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
      expect(firstDifference(ts, requireWasm().edge_segment_tests(input))).toBeUndefined()
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
    expect(reach.crosses).toBeGreaterThan(24)
    expect(reach.hits).toBeGreaterThan(34)
    expect(reach.atAnEnd).toBeGreaterThan(160)
    expect(reach.tooNearAnEnd).toBeGreaterThan(65)
    expect(reach.overflowed).toBeGreaterThan(150)
  })
})
