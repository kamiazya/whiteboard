// Generic framework invariants over the composed PREFERENCE-rule candidate
// generation (edge-rules.ts's composeSidePairs), independent of any one
// rule's geometry: totality and determinism are true for the full
// composition on ANY two-node offset; the order-only claim is scoped to
// the one rule that actually satisfies it (see the describe block below for
// why the other candidate-contributing rules are presence-gated, not
// order-only) plus a weaker monotonic-removal property that holds for all
// of them.
import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../../test-utils/fast-check.js'
import { referenceReversalCount } from '../../test-utils/reversal-count.js'
import {
  bendCount,
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

/** The declared slot for a rule, so a deliberate tier reorder never edits a test. */
const tierOf = (name: string): number => {
  const rule = PENALTY_RULES.find((r) => r.name === name)
  if (rule === undefined) throw new Error(`no penalty rule named ${name}`)
  return rule.tier
}

const rectArb: fc.Arbitrary<Rect> = fc.record({
  x: fc.integer({ min: -100, max: 100 }),
  y: fc.integer({ min: -100, max: 100 }),
  // Zero stays a legal JSON Canvas size (model pins it): the
  // framework invariants must hold for collapsed boxes too.
  w: fc.integer({ min: 0, max: 120 }),
  h: fc.integer({ min: 0, max: 120 }),
})

/**
 * An offset drawn INDEPENDENTLY of the two rects, so what a rule reads
 * (`dx`/`dy`) and what it measures (the rect coordinates) may disagree. That
 * is the right domain for the FRAMEWORK invariants below — totality,
 * determinism, tier placement — because a caller can hand `composeSidePairs`
 * any pair of numbers, and a rule may not throw on an incoherent one.
 *
 * It is the wrong domain for the removal properties, and measurably so: with
 * `dx`/`dy` uniform over [-300,300] against rects placed independently,
 * `zero-bend-facing-first` contributed a candidate in 16 of 200 draws and
 * `u-hook-when-degenerate` in 1 of 200, so a property about removing either
 * was a no-op in over 90% of its runs. `coherentContextArb` below is what
 * those use instead.
 */
const incoherentContextArb: fc.Arbitrary<PreferenceRuleContext> = fc
  .record({
    dx: fc.integer({ min: -300, max: 300 }),
    dy: fc.integer({ min: -300, max: 300 }),
    fromRect: rectArb,
    toRect: rectArb,
  })
  .map(({ dx, dy, fromRect, toRect }) => ({ dx, dy, fromRect, toRect, crowd: () => 0 }))

/** Zero, then small (interpenetrating at these box sizes), then far. */
const centreOffsetArb = fc.oneof(
  { arbitrary: fc.constant(0), weight: 2 },
  { arbitrary: fc.integer({ min: -60, max: 60 }), weight: 3 },
  { arbitrary: fc.integer({ min: -300, max: 300 }), weight: 2 },
)

/**
 * The offset IS the two rects' centre delta, which is what
 * `composeSidePairs` assumes of a real canvas — so `hvSides` and
 * `facingGapOk` agree about which way `to` lies, and the branches that need
 * that agreement become reachable. Both axes are biased toward zero and
 * toward small offsets relative to the box sizes, because the aligned
 * (`dx === 0`) and interpenetrating arrangements are exactly where
 * `zero-bend-facing-first` and `u-hook-when-degenerate` live: a uniform
 * offset reaches `dx === 0` once in 601 draws.
 *
 * `the domain reaches every candidate rule` below pins that this stays true.
 */
const coherentContextArb: fc.Arbitrary<PreferenceRuleContext> = fc
  .record({
    fromRect: rectArb,
    toSize: fc.record({
      w: fc.integer({ min: 0, max: 120 }),
      h: fc.integer({ min: 0, max: 120 }),
    }),
    dx: centreOffsetArb,
    dy: centreOffsetArb,
  })
  .map(({ fromRect, toSize, dx, dy }) => {
    const centreX = fromRect.x + fromRect.w / 2
    const centreY = fromRect.y + fromRect.h / 2
    const toRect = {
      x: Math.round(centreX + dx - toSize.w / 2),
      y: Math.round(centreY + dy - toSize.h / 2),
      w: toSize.w,
      h: toSize.h,
    }
    // The rounding above moves a centre by at most half a pixel, so the
    // offset the rules read is re-derived from the rects rather than
    // asserted, keeping the context self-consistent by construction.
    return {
      dx: toRect.x + toRect.w / 2 - centreX,
      dy: toRect.y + toRect.h / 2 - centreY,
      fromRect,
      toRect,
      crowd: () => 0,
    }
  })

/** Both shapes, for the invariants that must hold whatever a caller passes. */
const contextArb: fc.Arbitrary<PreferenceRuleContext> = fc.oneof(
  incoherentContextArb,
  coherentContextArb,
)

type CandidateRule = Extract<(typeof SIDE_PREFERENCE_RULES)[number], { kind: 'candidates' }>

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
  // A removal property over a domain that never makes the rule fire is a
  // no-op dressed as a check, and both properties below are removals. This
  // is the reachability half, asserted per rule rather than in aggregate so
  // one rule falling out of the domain cannot hide behind the other four.
  it('the domain reaches every candidate rule', () => {
    const samples = fc.sample(coherentContextArb, 400)
    const reached = SIDE_PREFERENCE_RULES.filter((rule) => rule.kind === 'candidates').map(
      (rule) => ({
        name: rule.name,
        // A floor, not the measurement: the thinnest rule here sits an order
        // of magnitude above it, so a real loss of reach fails and ordinary
        // sampling noise does not.
        reachedEnough:
          samples.filter((ctx) => (rule as CandidateRule).generate(ctx).length > 0).length >= 8,
      }),
    )
    expect(reached).toEqual(reached.map(({ name }) => ({ name, reachedEnough: true })))
  })

  // zero-bend-facing-first is the one rule whose own candidates are ALWAYS
  // a subset of what gap-valid-opposing-before-invalid contributes anyway
  // (both draw from {opposingH, opposingV}, and gap-valid-opposing-before-
  // invalid includes both unconditionally) — so removing it changes ORDER
  // only, never the candidate SET.
  fcTest.prop([coherentContextArb], withDefaults())(
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
  fcTest.prop([coherentContextArb], withDefaults())(
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
// and degenerate paths per the model contract (zero is a legal
// JSON Canvas node size) rather than well-formed routed geometry.
const pointArb: fc.Arbitrary<Point> = fc.record({
  x: fc.integer({ min: -200, max: 200 }),
  y: fc.integer({ min: -200, max: 200 }),
})

const axisMoveArb = fc.record({
  axis: fc.constantFrom<'h' | 'v'>('h', 'v'),
  delta: fc.integer({ min: -20, max: 20 }),
})

const orthogonalPathArb: fc.Arbitrary<readonly Point[]> = fc
  .array(axisMoveArb, { minLength: 0, maxLength: 10 })
  .map((moves) => {
    let x = 0
    let y = 0
    const path: Point[] = [{ x, y }]
    for (const move of moves) {
      if (move.axis === 'h') x += move.delta
      else y += move.delta
      path.push({ x, y })
    }
    return path
  })

/**
 * Free-form points AND an axis-aligned walk. Every ink term rejects by axis
 * before it measures anything, so a domain of free-form points prices
 * nothing: measured, five of the seven rules contributed 0 in 200 of 200
 * runs, which left the tier-placement property below comparing zero to zero
 * — a composition that never wrote a rule's slot would have passed it.
 */
const pathArb: fc.Arbitrary<readonly Point[]> = fc.oneof(
  fc.array(pointArb, { minLength: 0, maxLength: 6 }),
  orthogonalPathArb.map((path) => path.map((p) => ({ x: p.x * 4, y: p.y * 4 }))),
)

const foreignRectArb: fc.Arbitrary<Rect> = fc.record({
  x: fc.integer({ min: -200, max: 200 }),
  y: fc.integer({ min: -200, max: 200 }),
  // Zero-size rects are legal (model): a degenerate foreign body
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

/**
 * A narrow-phase term, zero often enough that a cost tuple with NOTHING in
 * it is reachable. `hasRepairableProblem`'s whole job is to answer false for
 * that tuple, and a uniform `integer(0..1000)` per slot puts three
 * simultaneous zeroes at one draw in a billion — measured 0 of 200 runs, and
 * the property stayed green with the function replaced by `return true`.
 */
const termArb = fc.oneof(
  { arbitrary: fc.constant(0), weight: 1 },
  { arbitrary: fc.integer({ min: 0, max: 1000 }), weight: 2 },
)

const tripleArb: fc.Arbitrary<readonly [number, number, number]> = fc.oneof(
  { arbitrary: fc.constant([0, 0, 0] as const), weight: 1 },
  { arbitrary: fc.tuple(termArb, termArb, termArb), weight: 5 },
)

describe('PENALTY_RULES: each rule writes only its declared tier slot', () => {
  fcTest.prop([tripleArb], withDefaults())(
    'pairPenalty places every rule contribution at rule.tier, for any narrow-phase triple',
    (triple) => {
      const cost = pairPenalty(triple)
      for (const rule of PENALTY_RULES) expect(cost[rule.tier]).toBe(rule.pairTerm(triple))
    },
  )

  fcTest.prop([pathArb, foreignBodiesArb, nodeBordersArb, foreignBodiesArb], withDefaults())(
    'selfPenalty places every rule contribution at rule.tier, for any path/foreign-body/node-border/endpoint-rect quadruple',
    (path, foreignBodies, nodeBorders, endpointRects) => {
      const cost = selfPenalty(path, foreignBodies, nodeBorders, endpointRects)
      for (const rule of PENALTY_RULES) {
        expect(cost[rule.tier]).toBe(rule.selfTerm(path, foreignBodies, nodeBorders, endpointRects))
      }
    },
  )

  /**
   * The tier-placement properties compare a composed slot against the rule's
   * own term, so a domain where every term is zero compares zero to zero and
   * a composition that never wrote a slot passes. This is the reachability
   * half: each rule has to be seen contributing something, at least once,
   * through the same composed call.
   */
  it('the domain makes every penalty rule contribute a nonzero term', () => {
    const samples = fc.sample(
      fc.tuple(pathArb, foreignBodiesArb, nodeBordersArb, foreignBodiesArb),
      600,
    )
    const reached = PENALTY_RULES.map((rule) => ({
      name: rule.name,
      contributes:
        samples.some(
          ([path, foreign, borders, endpoints]) =>
            selfPenalty(path, foreign, borders, endpoints)[rule.tier] !== 0,
        ) ||
        // pairTerm-only rules (overlap, illegibility, crossings) read the
        // narrow-phase triple instead, and have no self contribution at all.
        rule.pairTerm([1, 1, 1]) !== 0,
    }))
    expect(reached).toEqual(reached.map(({ name }) => ({ name, contributes: true })))
  })
})

describe('PENALTY_RULES: scorers are deterministic', () => {
  fcTest.prop([tripleArb], withDefaults())('pairPenalty is pure', (triple) => {
    expect(pairPenalty(triple)).toEqual(pairPenalty(triple))
  })

  fcTest.prop([pathArb, foreignBodiesArb, nodeBordersArb, foreignBodiesArb], withDefaults())(
    'selfPenalty is pure',
    (path, foreignBodies, nodeBorders, endpointRects) => {
      expect(selfPenalty(path, foreignBodies, nodeBorders, endpointRects)).toEqual(
        selfPenalty(path, foreignBodies, nodeBorders, endpointRects),
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

  fcTest.prop([pathArb, foreignBodiesArb, nodeBordersArb, foreignBodiesArb], withDefaults())(
    'selfPenalty totality, incl. zero-size rects, empty/single-point/zero-length paths',
    (path, foreignBodies, nodeBorders, endpointRects) => {
      for (const n of selfPenalty(path, foreignBodies, nodeBorders, endpointRects)) {
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
      expect(cost1[tierOf('border-tracing')]).toBe(cost2[tierOf('border-tracing')])
      expect(Number.isInteger(cost1[tierOf('border-tracing')])).toBe(true)
      expect(cost1[tierOf('border-tracing')]).toBeGreaterThanOrEqual(0)
    },
  )

  fcTest.prop([tracingScenarioArb], withDefaults())(
    'is invariant under permutation of the node-border array (a sum must not depend on order)',
    ({ path, nodeBorders }) => {
      const shuffled = [...nodeBorders].reverse()
      expect(selfPenalty(path, [], nodeBorders)[tierOf('border-tracing')]).toBe(
        selfPenalty(path, [], shuffled)[tierOf('border-tracing')],
      )
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
      expect(selfPenalty(path, [], nodeBorders)[tierOf('border-tracing')]).toBe(
        referenceBorderTrace(path, nodeBorders),
      )
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
      expect(cost1[tierOf('endpoint-body-ink')]).toBe(cost2[tierOf('endpoint-body-ink')])
      expect(Number.isInteger(cost1[tierOf('endpoint-body-ink')])).toBe(true)
      expect(cost1[tierOf('endpoint-body-ink')]).toBeGreaterThanOrEqual(0)
    },
  )

  fcTest.prop([endpointBodyInkScenarioArb], withDefaults())(
    'is invariant under permutation of the endpoint-rect array (a sum must not depend on order)',
    ({ path, endpointRects }) => {
      const shuffled = [...endpointRects].reverse()
      expect(selfPenalty(path, [], [], endpointRects)[tierOf('endpoint-body-ink')]).toBe(
        selfPenalty(path, [], [], shuffled)[tierOf('endpoint-body-ink')],
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
      expect(selfPenalty(path, [], [], endpointRects)[tierOf('endpoint-body-ink')]).toBe(
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

// path-reversal-specific properties: pathArb's four-point-max, +-200-range
// generic domain rarely lands two consecutive same-axis moves with opposite
// signs (passes vacuously — see AGENTS.md's PBT discipline), so this domain
// builds a path as an explicit walk of alternating-or-not axis moves, dense
// enough that a same-axis sign flip (a reversal) is common rather than rare.
// All generator coordinates here are integers, so COST_QUANTUM rounding in
// the production rule never changes a sign — no quantization drift to
// account for against the oracle, unlike the ink-length oracles above.
const pathReversalRule = penaltyRule('path-reversal')

describe('path-reversal: dense-orthogonal-walk property (mutation-checked)', () => {
  it('the generator actually produces reversing paths (not vacuous)', () => {
    const samples = fc.sample(orthogonalPathArb, 200)
    expect(samples.some((path) => referenceReversalCount(path) > 0)).toBe(true)
  })

  fcTest.prop([orthogonalPathArb], withDefaults())(
    'the path-reversal term is a finite, non-negative, integral, deterministic total',
    (path) => {
      const term1 = pathReversalRule.selfTerm(path, [], [], [])
      const term2 = pathReversalRule.selfTerm(path, [], [], [])
      expect(term1).toBe(term2)
      expect(Number.isInteger(term1)).toBe(true)
      expect(term1).toBeGreaterThanOrEqual(0)
    },
  )

  // The property that actually catches a "returns 0" or otherwise-wrong
  // mutation: totality/determinism above hold trivially for a stub that
  // always returns 0, so this is the one that must go red under mutation
  // (verified: reverting pathReversal.selfTerm to `() => 0` fails this
  // test, confirming the dense generator reaches real reversals).
  fcTest.prop([orthogonalPathArb], withDefaults())(
    'agrees with an independently-computed per-axis reversal count',
    (path) => {
      expect(pathReversalRule.selfTerm(path, [], [], [])).toBe(referenceReversalCount(path))
    },
  )

  fcTest.prop(
    [orthogonalPathArb, fc.integer({ min: -500, max: 500 }), fc.integer({ min: -500, max: 500 })],
    withDefaults(),
  )('is invariant under translating the whole path by any offset', (path, dx, dy) => {
    const translated = path.map((p) => ({ x: p.x + dx, y: p.y + dy }))
    expect(pathReversalRule.selfTerm(translated, [], [], [])).toBe(
      pathReversalRule.selfTerm(path, [], [], []),
    )
  })

  fcTest.prop([orthogonalPathArb], withDefaults())(
    'is invariant under reversing the point order',
    (path) => {
      const reversed = [...path].reverse()
      expect(pathReversalRule.selfTerm(reversed, [], [], [])).toBe(
        pathReversalRule.selfTerm(path, [], [], []),
      )
    },
  )

  // Cross-rule: a reversal is always a direction change, so this tier can
  // never exceed its realized-bends sibling — ties the two rules together
  // instead of letting them drift independently.
  fcTest.prop([orthogonalPathArb], withDefaults())(
    'reversalCount never exceeds bendCount, for any generated path',
    (path) => {
      expect(pathReversalRule.selfTerm(path, [], [], [])).toBeLessThanOrEqual(bendCount(path))
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
