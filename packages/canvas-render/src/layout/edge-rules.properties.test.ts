// Generic framework invariants over the composed PREFERENCE-rule candidate
// generation (edge-rules.ts's composeSidePairs), independent of any one
// rule's geometry: totality and determinism are true for the full
// composition on ANY two-node offset; the order-only claim is scoped to
// the one rule that actually satisfies it (see the describe block below for
// why the other candidate-contributing rules are presence-gated, not
// order-only) plus a weaker monotonic-removal property that holds for all
// of them.
import { describe, expect } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import {
  COST_QUANTUM,
  composeSidePairs,
  hasRepairableProblem,
  PENALTY_RULES,
  type Point,
  type PreferenceRuleContext,
  pairPenalty,
  type Rect,
  SIDE_PREFERENCE_RULES,
  type SidePair,
  selfPenalty,
} from './edge-rules.js'

const rectArb: fc.Arbitrary<Rect> = fc.record({
  x: fc.integer({ min: -100, max: 100 }),
  y: fc.integer({ min: -100, max: 100 }),
  // Zero stays a legal JSON Canvas size (canvas-model pins it): the
  // framework invariants must hold for collapsed boxes too.
  w: fc.integer({ min: 0, max: 120 }),
  h: fc.integer({ min: 0, max: 120 }),
})

// Dense enough to land on every branch composeSidePairs takes: aligned
// (dx or dy === 0), diagonal (both nonzero), interpenetrating rects
// (overlapping ranges within [-100,100]/[10,120]), and disjoint rects.
const contextArb: fc.Arbitrary<PreferenceRuleContext> = fc
  .record({
    dx: fc.integer({ min: -300, max: 300 }),
    dy: fc.integer({ min: -300, max: 300 }),
    fromRect: rectArb,
    toRect: rectArb,
  })
  .map(({ dx, dy, fromRect, toRect }) => ({ dx, dy, fromRect, toRect, crowd: () => 0 }))

const pairKey = (p: SidePair) => `${p.fromSide} ${p.toSide}`
const asSet = (pairs: readonly SidePair[]) => new Set(pairs.map(pairKey))

describe('composeSidePairs: candidate generation is total', () => {
  fcTest.prop([contextArb], withDefaults())(
    'never returns an empty list, for any two-node offset',
    (ctx) => {
      expect(composeSidePairs(ctx).length).toBeGreaterThan(0)
    },
  )
})

describe('composeSidePairs: candidate generation is deterministic', () => {
  fcTest.prop([contextArb], withDefaults())(
    'same inputs produce the same ordered list twice',
    (ctx) => {
      expect(composeSidePairs(ctx)).toEqual(composeSidePairs(ctx))
    },
  )
})

describe('composeSidePairs: preference-rule removal', () => {
  // zero-bend-facing-first is the one rule whose own candidates are ALWAYS
  // a subset of what gap-valid-opposing-before-invalid contributes anyway
  // (both draw from {opposingH, opposingV}, and gap-valid-opposing-before-
  // invalid includes both unconditionally) — so removing it changes ORDER
  // only, never the candidate SET.
  fcTest.prop([contextArb], withDefaults())(
    'removing zero-bend-facing-first changes ordering but never the candidate set',
    (ctx) => {
      const withRule = asSet(composeSidePairs(ctx))
      const withoutRule = asSet(
        composeSidePairs(
          ctx,
          SIDE_PREFERENCE_RULES.filter((r) => r.name !== 'zero-bend-facing-first'),
        ),
      )
      expect(withoutRule).toEqual(withRule)
    },
  )

  // l-pair-crowding-tie-break, u-hook-when-degenerate and gap-valid-
  // opposing-before-invalid each gate the PRESENCE of candidates no other
  // rule produces (perpendicular L pairs, same-side U-hooks, and the
  // second opposing pair respectively) — removing any of them legitimately
  // shrinks the set, so they are not order-only. What DOES hold for every
  // candidate rule, always, is monotonicity: removing one can only drop
  // candidates, never introduce one the full composition never had.
  fcTest.prop([contextArb], withDefaults())(
    'removing any single candidate rule never introduces a candidate absent from the full composition',
    (ctx) => {
      const full = asSet(composeSidePairs(ctx))
      for (const rule of SIDE_PREFERENCE_RULES) {
        if (rule.kind !== 'candidates') continue
        const without = asSet(
          composeSidePairs(
            ctx,
            SIDE_PREFERENCE_RULES.filter((r) => r.name !== rule.name),
          ),
        )
        for (const key of without) expect(full.has(key)).toBe(true)
      }
    },
  )
})

// PENALTY-rule framework invariants (edge-rules.ts's PENALTY_RULES): the
// slot a rule writes into is derived from its declared `tier`, never a
// hardcoded array position, so the domain below leans on zero-size rects
// and degenerate paths per the canvas-model contract (zero is a legal
// JSON Canvas node size) rather than well-formed routed geometry.
const pointArb: fc.Arbitrary<Point> = fc.record({
  x: fc.integer({ min: -200, max: 200 }),
  y: fc.integer({ min: -200, max: 200 }),
})

const pathArb: fc.Arbitrary<readonly Point[]> = fc.array(pointArb, { minLength: 0, maxLength: 6 })

const foreignRectArb: fc.Arbitrary<Rect> = fc.record({
  x: fc.integer({ min: -200, max: 200 }),
  y: fc.integer({ min: -200, max: 200 }),
  // Zero-size rects are legal (canvas-model): a degenerate foreign body
  // must never make a scorer throw or return a non-finite total.
  w: fc.integer({ min: 0, max: 200 }),
  h: fc.integer({ min: 0, max: 200 }),
})

const foreignBodiesArb: fc.Arbitrary<readonly Rect[]> = fc.array(foreignRectArb, {
  minLength: 0,
  maxLength: 4,
})

// Node-border domain for the border-tracing rule: same shape as the
// foreign-body domain (mutually overlapping and zero-size rects included).
const nodeBordersArb = foreignBodiesArb

const tripleArb: fc.Arbitrary<readonly [number, number, number]> = fc.tuple(
  fc.integer({ min: 0, max: 1000 }),
  fc.integer({ min: 0, max: 1000 }),
  fc.integer({ min: 0, max: 1000 }),
)

describe('PENALTY_RULES: each rule writes only its declared tier slot', () => {
  fcTest.prop([tripleArb], withDefaults())(
    'pairPenalty places every rule contribution at rule.tier, for any narrow-phase triple',
    (triple) => {
      const cost = pairPenalty(triple)
      for (const rule of PENALTY_RULES) expect(cost[rule.tier]).toBe(rule.pairTerm(triple))
    },
  )

  fcTest.prop([pathArb, foreignBodiesArb, nodeBordersArb], withDefaults())(
    'selfPenalty places every rule contribution at rule.tier, for any path/foreign-body/node-border triple',
    (path, foreignBodies, nodeBorders) => {
      const cost = selfPenalty(path, foreignBodies, nodeBorders)
      for (const rule of PENALTY_RULES) {
        expect(cost[rule.tier]).toBe(rule.selfTerm(path, foreignBodies, nodeBorders, []))
      }
    },
  )
})

describe('PENALTY_RULES: scorers are deterministic', () => {
  fcTest.prop([tripleArb], withDefaults())('pairPenalty is pure', (triple) => {
    expect(pairPenalty(triple)).toEqual(pairPenalty(triple))
  })

  fcTest.prop([pathArb, foreignBodiesArb, nodeBordersArb], withDefaults())(
    'selfPenalty is pure',
    (path, foreignBodies, nodeBorders) => {
      expect(selfPenalty(path, foreignBodies, nodeBorders)).toEqual(
        selfPenalty(path, foreignBodies, nodeBorders),
      )
    },
  )
})

describe('PENALTY_RULES: totals are finite non-negative integers', () => {
  fcTest.prop([tripleArb], withDefaults())(
    'pairPenalty totality, incl. degenerate triples',
    (triple) => {
      for (const n of pairPenalty(triple)) {
        expect(Number.isInteger(n)).toBe(true)
        expect(n).toBeGreaterThanOrEqual(0)
      }
    },
  )

  fcTest.prop([pathArb, foreignBodiesArb, nodeBordersArb], withDefaults())(
    'selfPenalty totality, incl. zero-size rects, empty/single-point/zero-length paths',
    (path, foreignBodies, nodeBorders) => {
      for (const n of selfPenalty(path, foreignBodies, nodeBorders)) {
        expect(Number.isInteger(n)).toBe(true)
        expect(n).toBeGreaterThanOrEqual(0)
      }
    },
  )
})

// border-tracing-specific properties: pathArb/nodeBordersArb sampled
// independently would rarely land a segment exactly on a border (passing
// vacuously — see AGENTS.md's PBT discipline), so this domain builds a path
// FROM the border rects by snapping coordinates onto a rect's sides,
// mixed with the generic pathArb via fc.oneof for coverage of the
// non-tracing branches too.
const tracingPointArb = (rect: Rect): fc.Arbitrary<Point> =>
  fc.oneof(
    // On the top/bottom border, x anywhere within a generous span (may
    // overhang the rect — exercises the clipping branch).
    fc.record({
      x: fc.integer({ min: rect.x - 50, max: rect.x + rect.w + 50 }),
      y: fc.constantFrom(rect.y, rect.y + rect.h),
    }),
    // On the left/right border.
    fc.record({
      x: fc.constantFrom(rect.x, rect.x + rect.w),
      y: fc.integer({ min: rect.y - 50, max: rect.y + rect.h + 50 }),
    }),
    pointArb,
  )

const borderRectArb: fc.Arbitrary<Rect> = fc.record({
  x: fc.integer({ min: -100, max: 100 }),
  y: fc.integer({ min: -100, max: 100 }),
  w: fc.integer({ min: 0, max: 150 }),
  h: fc.integer({ min: 0, max: 150 }),
})

// The rect a tracing path was BUILT from is folded into nodeBorders
// (alongside independently generated extras) so the equality property
// below always has a real chance of finding a positive-overlap segment —
// generating path and nodeBorders fully independently would only rarely
// line a segment up with a border by chance.
const tracingScenarioArb: fc.Arbitrary<{
  path: readonly Point[]
  nodeBorders: readonly Rect[]
}> = fc.tuple(borderRectArb, nodeBordersArb).chain(([rect, extras]) =>
  fc.array(tracingPointArb(rect), { minLength: 0, maxLength: 6 }).map((path) => ({
    path,
    nodeBorders: [rect, ...extras],
  })),
)

/** Independent oracle (never calls production code): the same collinear-
 * overlap-length definition, computed directly against the reference
 * rects. All generator coordinates are integers, so multiplying by
 * COST_QUANTUM at the end is exact — no quantization drift from the
 * production rule's per-coordinate `q()` rounding. */
function referenceBorderTrace(path: readonly Point[], rects: readonly Rect[]): number {
  let total = 0
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] as Point
    const b = path[i] as Point
    for (const r of rects) {
      if (a.y === b.y && (a.y === r.y || a.y === r.y + r.h)) {
        const lo = Math.max(Math.min(a.x, b.x), r.x)
        const hi = Math.min(Math.max(a.x, b.x), r.x + r.w)
        if (hi > lo) total += hi - lo
      } else if (a.x === b.x && (a.x === r.x || a.x === r.x + r.w)) {
        const lo = Math.max(Math.min(a.y, b.y), r.y)
        const hi = Math.min(Math.max(a.y, b.y), r.y + r.h)
        if (hi > lo) total += hi - lo
      }
    }
  }
  return total * COST_QUANTUM
}

describe('border-tracing: dense-on-borders property (mutation-checked)', () => {
  fcTest.prop([tracingScenarioArb], withDefaults())(
    'the border-tracing term is a finite, non-negative, integral, deterministic total',
    ({ path, nodeBorders }) => {
      const cost1 = selfPenalty(path, [], nodeBorders)
      const cost2 = selfPenalty(path, [], nodeBorders)
      expect(cost1[3]).toBe(cost2[3])
      expect(Number.isInteger(cost1[3])).toBe(true)
      expect(cost1[3]).toBeGreaterThanOrEqual(0)
    },
  )

  fcTest.prop([tracingScenarioArb], withDefaults())(
    'is invariant under permutation of the node-border array (a sum must not depend on order)',
    ({ path, nodeBorders }) => {
      const shuffled = [...nodeBorders].reverse()
      expect(selfPenalty(path, [], nodeBorders)[3]).toBe(selfPenalty(path, [], shuffled)[3])
    },
  )

  // The property that actually catches a "returns 0" or otherwise-wrong
  // mutation: totality/purity/order-invariance above all hold trivially for
  // a stub that always returns 0, so this is the one that must go red under
  // mutation (verified: reverting borderTracing.selfTerm to `() => 0` fails
  // this test, confirming the dense generator reaches real overlap).
  fcTest.prop([tracingScenarioArb], withDefaults())(
    'agrees with an independently-computed collinear overlap length',
    ({ path, nodeBorders }) => {
      expect(selfPenalty(path, [], nodeBorders)[3]).toBe(referenceBorderTrace(path, nodeBorders))
    },
  )
})

// endpoint-body-ink-specific properties: analogous to the border-tracing
// block above, but the dense domain snaps generated points to the
// STRICT INTERIOR of a rect (rather than its border) so the property has a
// real chance of finding a positive interior chord instead of passing
// vacuously.
const interiorPointArb = (rect: Rect): fc.Arbitrary<Point> =>
  fc.oneof(
    // y strictly between the rect's top and bottom (when the rect is tall
    // enough for one to exist), x ranging generously so the clipping
    // branch is exercised too.
    fc.record({
      x: fc.integer({ min: rect.x - 50, max: rect.x + rect.w + 50 }),
      y:
        rect.h >= 2
          ? fc.integer({ min: rect.y + 1, max: rect.y + rect.h - 1 })
          : fc.constant(rect.y),
    }),
    // x strictly between the rect's left and right.
    fc.record({
      x:
        rect.w >= 2
          ? fc.integer({ min: rect.x + 1, max: rect.x + rect.w - 1 })
          : fc.constant(rect.x),
      y: fc.integer({ min: rect.y - 50, max: rect.y + rect.h + 50 }),
    }),
    pointArb,
  )

const endpointRectArb: fc.Arbitrary<Rect> = borderRectArb

// The rect a chord was BUILT from is folded into endpointRects (alongside
// independently generated extras, and a chance of a CONTAINER rect around
// it) so the oracle-equality property below always has a real chance of
// exercising both the interior-chord branch and the containment exclusion.
const endpointBodyInkScenarioArb: fc.Arbitrary<{
  path: readonly Point[]
  endpointRects: readonly Rect[]
}> = fc
  .tuple(endpointRectArb, foreignBodiesArb, fc.boolean(), fc.boolean())
  .chain(([rect, extras, wrapped, duplicated]) =>
    fc.array(interiorPointArb(rect), { minLength: 0, maxLength: 6 }).map((path) => ({
      path,
      // `duplicated` reaches the equal-rect case deterministically instead of
      // waiting for the generator to collide: two identical endpoint rects
      // contain each other, which the PROPER-containment exclusion keeps
      // priced and a plain-containment one would silently drop.
      endpointRects: [
        ...(wrapped ? [{ x: rect.x - 10, y: rect.y - 10, w: rect.w + 20, h: rect.h + 20 }] : []),
        rect,
        ...(duplicated ? [{ ...rect }] : []),
        ...extras,
      ],
    })),
  )

/** Independent oracle (never calls production code): total STRICTLY
 * interior chord length, container rects excluded. All generator
 * coordinates are integers, so multiplying by COST_QUANTUM at the end is
 * exact — no quantization drift from the production rule's `q()`. */
function referenceEndpointBodyInk(path: readonly Point[], rects: readonly Rect[]): number {
  const containsRect = (outer: Rect, inner: Rect): boolean =>
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  // PROPER containment only: two identical rects each contain the other, and
  // neither is a group frame around the other, so both stay priced.
  const priced = rects.filter(
    (r) => !rects.some((other) => other !== r && containsRect(r, other) && !containsRect(other, r)),
  )
  let total = 0
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] as Point
    const b = path[i] as Point
    for (const r of priced) {
      if (a.y === b.y && a.y > r.y && a.y < r.y + r.h) {
        const lo = Math.max(Math.min(a.x, b.x), r.x)
        const hi = Math.min(Math.max(a.x, b.x), r.x + r.w)
        if (hi > lo) total += hi - lo
      } else if (a.x === b.x && a.x > r.x && a.x < r.x + r.w) {
        const lo = Math.max(Math.min(a.y, b.y), r.y)
        const hi = Math.min(Math.max(a.y, b.y), r.y + r.h)
        if (hi > lo) total += hi - lo
      }
    }
  }
  return total * COST_QUANTUM
}

describe('endpoint-body-ink: dense-interior property (mutation-checked)', () => {
  fcTest.prop([endpointBodyInkScenarioArb], withDefaults())(
    'the endpoint-body-ink term is a finite, non-negative, integral, deterministic total',
    ({ path, endpointRects }) => {
      const cost1 = selfPenalty(path, [], [], endpointRects)
      const cost2 = selfPenalty(path, [], [], endpointRects)
      expect(cost1[4]).toBe(cost2[4])
      expect(Number.isInteger(cost1[4])).toBe(true)
      expect(cost1[4]).toBeGreaterThanOrEqual(0)
    },
  )

  fcTest.prop([endpointBodyInkScenarioArb], withDefaults())(
    'is invariant under permutation of the endpoint-rect array (a sum must not depend on order)',
    ({ path, endpointRects }) => {
      const shuffled = [...endpointRects].reverse()
      expect(selfPenalty(path, [], [], endpointRects)[4]).toBe(
        selfPenalty(path, [], [], shuffled)[4],
      )
    },
  )

  // The property that actually catches a "returns 0" or otherwise-wrong
  // mutation: totality/purity/order-invariance above all hold trivially for
  // a stub that always returns 0, so this is the one that must go red under
  // mutation (verified: reverting endpointBodyInk.selfTerm to `() => 0`
  // fails this test, confirming the dense generator reaches real interior
  // chords — including through the containment-exclusion branch).
  fcTest.prop([endpointBodyInkScenarioArb], withDefaults())(
    'agrees with an independently-computed strictly-interior chord length',
    ({ path, endpointRects }) => {
      expect(selfPenalty(path, [], [], endpointRects)[4]).toBe(
        referenceEndpointBodyInk(path, endpointRects),
      )
    },
  )
})

// No-double-charge: the SAME segment/rect pair must never be priced by both
// border-tracing (collinear ON the border) and endpoint-body-ink (STRICTLY
// between the two borders) — the two conditions are exact complements in
// quantized space. Generated segments mix on-border, strictly-interior, and
// exterior coordinates so the property has a real chance of making EITHER
// term positive.
const axisSegmentArb = (rect: Rect): fc.Arbitrary<{ a: Point; b: Point }> => {
  const yCandidates = fc.oneof(
    fc.constantFrom(rect.y, rect.y + rect.h),
    rect.h >= 2 ? fc.integer({ min: rect.y + 1, max: rect.y + rect.h - 1 }) : fc.constant(rect.y),
    fc.integer({ min: rect.y - 50, max: rect.y + rect.h + 50 }),
  )
  const xCandidates = fc.oneof(
    fc.constantFrom(rect.x, rect.x + rect.w),
    rect.w >= 2 ? fc.integer({ min: rect.x + 1, max: rect.x + rect.w - 1 }) : fc.constant(rect.x),
    fc.integer({ min: rect.x - 50, max: rect.x + rect.w + 50 }),
  )
  return fc.oneof(
    fc
      .record({
        y: yCandidates,
        x1: fc.integer({ min: rect.x - 50, max: rect.x + rect.w + 50 }),
        x2: fc.integer({ min: rect.x - 50, max: rect.x + rect.w + 50 }),
      })
      .map(({ y, x1, x2 }) => ({ a: { x: x1, y }, b: { x: x2, y } })),
    fc
      .record({
        x: xCandidates,
        y1: fc.integer({ min: rect.y - 50, max: rect.y + rect.h + 50 }),
        y2: fc.integer({ min: rect.y - 50, max: rect.y + rect.h + 50 }),
      })
      .map(({ x, y1, y2 }) => ({ a: { x, y: y1 }, b: { x, y: y2 } })),
  )
}

const complementarityArb: fc.Arbitrary<{ rect: Rect; a: Point; b: Point }> = borderRectArb.chain(
  (rect) => axisSegmentArb(rect).map(({ a, b }) => ({ rect, a, b })),
)

function penaltyRule(name: string): (typeof PENALTY_RULES)[number] {
  const rule = PENALTY_RULES.find((r) => r.name === name)
  if (rule === undefined) throw new Error(`no such rule: ${name}`)
  return rule
}
const borderTracingRule = penaltyRule('border-tracing')
const endpointBodyInkRule = penaltyRule('endpoint-body-ink')

describe('border-tracing / endpoint-body-ink: no double-charge', () => {
  fcTest.prop([complementarityArb], withDefaults())(
    'never charges the same single-segment/single-rect pair on both tiers',
    ({ rect, a, b }) => {
      const border = borderTracingRule.selfTerm([a, b], [], [rect], [])
      const endpointInk = endpointBodyInkRule.selfTerm([a, b], [], [], [rect])
      expect(Math.min(border, endpointInk)).toBe(0)
    },
  )
})

describe('hasRepairableProblem: derived from every tier below the last declared one', () => {
  fcTest.prop([tripleArb], withDefaults())(
    'agrees with a direct check of the non-final tiers, for any pairPenalty output',
    (triple) => {
      const cost = pairPenalty(triple)
      const expected = cost.slice(0, -1).some((n) => n !== 0)
      expect(hasRepairableProblem(cost)).toBe(expected)
    },
  )
})
