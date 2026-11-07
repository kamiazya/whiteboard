import { type EdgeSide, edgeSideSchema } from '@kamiazya/whiteboard-model'
import { afterAllFloor } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect } from 'vitest'
import type { Point, Rect } from '../../layout/edges/edge-geometry.js'
import {
  addCost,
  composeSidePairs,
  facingLaneWindow,
  hasRepairableProblem,
  lessCost,
  selfPenalty,
} from '../../layout/edges/edge-rules.js'
import { fc, fcTest, withDefaults } from '../fast-check.js'
import { coordinate, firstDifference, path, rect, rectsAgainst } from './edge-arbitraries.js'
import { built, requireWasm } from './glue.js'

/**
 * edge-rules.ts against its Rust port through the wasm artifact (ADR-0054
 * step 5, QR-21 layer 2): the side preference rules' ranking, the facing
 * lane window, every penalty tier of a path, and the cost tuple's
 * operations. Each side computes its own answer from the same draw, compared
 * exactly.
 */

const SIDES = edgeSideSchema.options
const sideIndex = (side: EdgeSide) => SIDES.indexOf(side)

/**
 * Two boxes and the offset between them. The offset is usually their
 * centres' (what side choice passes), sometimes zero on an axis (the
 * degenerate case the U-hook rule exists for), sometimes anything.
 */
const sidePairCase = fc
  .tuple(
    rect,
    rect,
    fc.constantFrom('centres', 'centres', 'aligned-x', 'aligned-y', 'free'),
    coordinate,
    coordinate,
    fc.array(fc.oneof(fc.integer({ min: 0, max: 3 }), fc.constant(Number.NaN)), {
      minLength: 8,
      maxLength: 8,
    }),
  )
  .map(([from, to, kind, fdx, fdy, crowd]) => {
    const cdx = to.x + to.w / 2 - (from.x + from.w / 2)
    const cdy = to.y + to.h / 2 - (from.y + from.h / 2)
    const [dx, dy] =
      kind === 'centres'
        ? [cdx, cdy]
        : kind === 'aligned-x'
          ? [0, cdy]
          : kind === 'aligned-y'
            ? [cdx, 0]
            : [fdx, fdy]
    return { from, to, dx, dy, crowd }
  })

/** Two boxes lined up on an axis often enough that their facing sides share a window. */
const facingPair = fc
  .tuple(
    rect,
    // Tall and wide enough that the inset spans can still overlap by the
    // zero-bend minimum; most draws of `size` cannot.
    fc.integer({ min: 8, max: 40 }).map((k) => k * 2.5),
    fc.integer({ min: 8, max: 40 }).map((k) => k * 2.5),
    coordinate,
    fc.boolean(),
  )
  .map(([from, w, h, gap, horizontal]): [Rect, Rect] => [
    from,
    horizontal
      ? { x: from.x + from.w + Math.abs(gap), y: from.y + (gap % 20), w, h }
      : { x: from.x + (gap % 20), y: from.y + from.h + Math.abs(gap), w, h },
  ])

const penaltyCase = path.chain((p) =>
  fc.tuple(fc.constant(p), rectsAgainst(p), rectsAgainst(p), rectsAgainst(p)),
)

const tier = fc.oneof(
  { weight: 6, arbitrary: fc.integer({ min: 0, max: 3 }) },
  { weight: 1, arbitrary: fc.constantFrom(-0, Number.NaN, -1) },
)
const costPair = fc.tuple(
  fc.array(tier, { minLength: 7, maxLength: 7 }),
  fc.array(tier, { minLength: 7, maxLength: 7 }),
  fc.constantFrom(1, -1),
)

const reach = {
  hookFirst: 0,
  opposingFirst: 0,
  crowdingReordered: 0,
  window: 0,
  noWindow: 0,
  tiers: [0, 0, 0, 0, 0, 0, 0],
  less: 0,
  repairable: 0,
}

const rectValues = (r: Rect) => [r.x, r.y, r.w, r.h]
const rectList = (rs: readonly Rect[]) => [rs.length, ...rs.flatMap(rectValues)]
const pointList = (ps: readonly Point[]) => [ps.length, ...ps.flatMap((q) => [q.x, q.y])]

describe.runIf(built)('edge-rules.ts and its Rust port answer the same', () => {
  fcTest.prop([fc.array(sidePairCase, { minLength: 1, maxLength: 16 })], withDefaults())(
    'side pairs',
    (cases) => {
      const ts = cases.flatMap(({ from, to, dx, dy, crowd }) => {
        const ranked = composeSidePairs({
          dx,
          dy,
          fromRect: from,
          toRect: to,
          crowd: (end, side) => crowd[(end === 'from' ? 0 : 4) + sideIndex(side)] as number,
        })
        const first = ranked[0]
        if (first?.fromSide === first?.toSide) reach.hookFirst += 1
        else reach.opposingFirst += 1
        // The L-pair rule sorts its two pairs by crowding: reached when the
        // offset is diagonal and the two pairs' crowds differ.
        if (dx !== 0 && dy !== 0 && !Number.isNaN(dx) && !Number.isNaN(dy)) {
          const at = (end: number, side: EdgeSide) => crowd[end + sideIndex(side)] as number
          const h: EdgeSide = dx >= 0 ? 'right' : 'left'
          const v: EdgeSide = dy >= 0 ? 'bottom' : 'top'
          const opposite = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' } as const
          if (at(0, h) + at(4, opposite[v]) !== at(0, v) + at(4, opposite[h]))
            reach.crowdingReordered += 1
        }
        return [
          ranked.length,
          ...ranked.flatMap((p) => [sideIndex(p.fromSide), sideIndex(p.toSide)]),
        ]
      })
      const input = Float64Array.from(
        cases.flatMap(({ from, to, dx, dy, crowd }) => [
          dx,
          dy,
          ...rectValues(from),
          ...rectValues(to),
          ...crowd,
        ]),
      )
      expect(firstDifference(ts, requireWasm().edge_side_pairs(input))).toBeUndefined()
    },
  )

  fcTest.prop(
    [fc.array(fc.oneof(facingPair, fc.tuple(rect, rect)), { minLength: 1, maxLength: 32 })],
    withDefaults(),
  )('lane windows', (pairs) => {
    const ts = pairs.flatMap(([from, to]) =>
      (['h', 'v'] as const).flatMap((axis) => {
        const window = facingLaneWindow(from, to, axis)
        if (window === undefined) reach.noWindow += 1
        else reach.window += 1
        return window === undefined ? [Number.NaN, Number.NaN] : [...window]
      }),
    )
    const input = Float64Array.from(
      pairs.flatMap(([from, to]) => [...rectValues(from), ...rectValues(to)]),
    )
    expect(firstDifference(ts, requireWasm().edge_lane_windows(input))).toBeUndefined()
  })

  fcTest.prop([penaltyCase], withDefaults())('self penalty', ([p, foreign, borders, endpoints]) => {
    const ts = selfPenalty(p, foreign, borders, endpoints)
    ts.forEach((value, i) => {
      if (value !== 0) reach.tiers[i] = (reach.tiers[i] ?? 0) + 1
    })
    const input = Float64Array.from([
      ...pointList(p),
      ...rectList(foreign),
      ...rectList(borders),
      ...rectList(endpoints),
    ])
    expect(firstDifference(ts, requireWasm().edge_self_penalty(input))).toBeUndefined()
  })

  fcTest.prop([fc.array(costPair, { minLength: 1, maxLength: 32 })], withDefaults())(
    'cost operations',
    (cases) => {
      const ts = cases.flatMap(([a, b, sign]) => {
        const less = lessCost(a, b)
        const repairable = hasRepairableProblem(a)
        if (less) reach.less += 1
        if (repairable) reach.repairable += 1
        return [less ? 1 : 0, lessCost(b, a) ? 1 : 0, repairable ? 1 : 0, ...addCost(a, b, sign)]
      })
      const input = Float64Array.from(cases.flatMap(([a, b, sign]) => [...a, ...b, sign]))
      expect(firstDifference(ts, requireWasm().edge_cost_ops(input))).toBeUndefined()
    },
  )

  afterAllFloor(['side pairs', 'lane windows', 'self penalty', 'cost operations'], () => {
    // Each rule and tier is reached, so agreement is not agreement on its
    // silence. Floors at about half of what three runs measured; tiers 1
    // and 2 are pairwise and a self penalty leaves them zero by definition.
    expect(reach.hookFirst).toBeGreaterThan(40)
    expect(reach.opposingFirst).toBeGreaterThan(500)
    expect(reach.crowdingReordered).toBeGreaterThan(290)
    expect(reach.window).toBeGreaterThan(50)
    expect(reach.noWindow).toBeGreaterThan(1000)
    expect(reach.tiers[0]).toBeGreaterThan(50)
    expect(reach.tiers[3]).toBeGreaterThan(22)
    expect(reach.tiers[4]).toBeGreaterThan(24)
    expect(reach.tiers[5]).toBeGreaterThan(50)
    expect(reach.tiers[6]).toBeGreaterThan(60)
    expect(reach.less).toBeGreaterThan(250)
    expect(reach.repairable).toBeGreaterThan(600)
  })
})
