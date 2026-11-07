import { type EdgeSide, edgeSideSchema } from '@kamiazya/whiteboard-model'
import { afterAllFloor } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect } from 'vitest'
import { compareNumbers } from '../../det-math.js'
import type { Point, Rect } from '../../layout/edges/edge-geometry.js'
import { inkAlongRects } from '../../layout/edges/edge-ink.js'
import {
  addCost,
  composeSidePairs,
  facingLaneWindow,
  fullyContains,
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
 * degenerate case the U-hook rule exists for), sometimes anything. Two
 * shapes are drawn on purpose because free boxes almost never make them:
 * wide boxes stacked with a horizontally dominant offset, where only the
 * NON-dominant facing qualifies for a zero bend, and a box nested in the
 * other, where the span-exposed rule returns its hooks unreordered; and
 * overlapping boxes, where a side's span runs through the other and is
 * moved to the back.
 */
function shaped(from: Rect, to: Rect, kind: string, a: number, b: number): [Rect, Rect] {
  if (kind === 'wide-stacked') {
    const wide = { x: from.x, y: from.y, w: 300, h: 40 }
    return [wide, { x: wide.x + 80 + a, y: wide.y + 40 + 10 + b / 4, w: 300, h: 40 }]
  }
  if (kind === 'overlapping') {
    // `from`'s right border runs through `to`'s interior.
    return [
      from,
      { x: from.x + from.w / 2, y: from.y - 5 - a / 4, w: from.w, h: from.h + 10 + b / 2 },
    ]
  }
  if (kind === 'nested') {
    return [from, { x: from.x - a, y: from.y - b, w: from.w + a + b + 5, h: from.h + a + b + 5 }]
  }
  return [from, to]
}

const sidePairCase = fc
  .tuple(
    rect,
    rect,
    fc.constantFrom(
      'centres',
      'centres',
      'aligned-x',
      'aligned-y',
      'free',
      'wide-stacked',
      'nested',
      'overlapping',
    ),
    coordinate,
    coordinate,
    fc.array(fc.oneof(fc.integer({ min: 0, max: 3 }), fc.constant(Number.NaN)), {
      minLength: 8,
      maxLength: 8,
    }),
  )
  .map(([drawnFrom, drawnTo, kind, fdx, fdy, crowd]) => {
    const [from, to] = shaped(drawnFrom, drawnTo, kind, Math.abs(fdx) % 60, Math.abs(fdy) % 60)
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
  crowdingSwapped: 0,
  zeroBendNonDominant: 0,
  hooksContained: 0,
  hooksTainted: 0,
  window: 0,
  noWindow: 0,
  tiers: [0, 0, 0, 0, 0, 0, 0],
  less: 0,
  repairable: 0,
}

const OPPOSITE = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' } as const

/** The border segment of `rect`'s `side`, as edge-rules' private `sideSegment`. */
function borderOf(rect: Rect, side: EdgeSide): [Point, Point] {
  const [l, t, r, b] = [rect.x, rect.y, rect.x + rect.w, rect.y + rect.h]
  if (side === 'top')
    return [
      { x: l, y: t },
      { x: r, y: t },
    ]
  if (side === 'bottom')
    return [
      { x: l, y: b },
      { x: r, y: b },
    ]
  if (side === 'left')
    return [
      { x: l, y: t },
      { x: l, y: b },
    ]
  return [
    { x: r, y: t },
    { x: r, y: b },
  ]
}

/**
 * Which of the rules' less common branches a case reaches, read with the
 * exported helpers the rules themselves are built from. Reach only: the
 * answer compared is composeSidePairs'.
 */
function countRuleReach(c: {
  from: Rect
  to: Rect
  dx: number
  dy: number
  crowd: number[]
}): void {
  const { from, to, dx, dy, crowd } = c
  if (Number.isNaN(dx) || Number.isNaN(dy)) return
  const h: EdgeSide = dx >= 0 ? 'right' : 'left'
  const v: EdgeSide = dy >= 0 ? 'bottom' : 'top'
  const horizontalFirst = Math.abs(dx) >= Math.abs(dy)
  // The L-pair sort SWAPS the dominant order: its second pair is less crowded.
  if (dx !== 0 && dy !== 0) {
    const crowdOf = (fromSide: EdgeSide, toSide: EdgeSide) =>
      (crowd[sideIndex(fromSide)] as number) + (crowd[4 + sideIndex(toSide)] as number)
    const l1 = crowdOf(h, OPPOSITE[v])
    const l2 = crowdOf(v, OPPOSITE[h])
    const [first, second] = horizontalFirst ? [l1, l2] : [l2, l1]
    if (compareNumbers(first, second) > 0) reach.crowdingSwapped += 1
  }
  // A zero bend on the NON-dominant axis only.
  const gapH = h === 'right' ? from.x + from.w <= to.x : to.x + to.w <= from.x
  const gapV = v === 'bottom' ? from.y + from.h <= to.y : to.y + to.h <= from.y
  const zeroH = gapH && facingLaneWindow(from, to, 'h') !== undefined
  const zeroV = gapV && facingLaneWindow(from, to, 'v') !== undefined
  if (horizontalFirst ? zeroV && !zeroH : zeroH && !zeroV) reach.zeroBendNonDominant += 1
  // The span-exposed rule: its early return, and a hook it moves to the back.
  if (fullyContains(to, from)) reach.hooksContained += 1
  else if (
    SIDES.some((s) => inkAlongRects(borderOf(from, s), [to], (f, n, x) => n < f && f < x) > 0)
  )
    reach.hooksTainted += 1
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
        countRuleReach({ from, to, dx, dy, crowd })
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
    expect(reach.hookFirst).toBeGreaterThan(25)
    expect(reach.opposingFirst).toBeGreaterThan(500)
    expect(reach.crowdingSwapped).toBeGreaterThan(70)
    expect(reach.zeroBendNonDominant).toBeGreaterThan(18)
    expect(reach.hooksContained).toBeGreaterThan(55)
    expect(reach.hooksTainted).toBeGreaterThan(50)
    expect(reach.window).toBeGreaterThan(45)
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
