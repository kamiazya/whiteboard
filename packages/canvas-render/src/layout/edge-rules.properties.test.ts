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

  fcTest.prop([pathArb, foreignBodiesArb], withDefaults())(
    'selfPenalty places every rule contribution at rule.tier, for any path/foreign-body pair',
    (path, foreignBodies) => {
      const cost = selfPenalty(path, foreignBodies)
      for (const rule of PENALTY_RULES) {
        expect(cost[rule.tier]).toBe(rule.selfTerm(path, foreignBodies))
      }
    },
  )
})

describe('PENALTY_RULES: scorers are deterministic', () => {
  fcTest.prop([tripleArb], withDefaults())('pairPenalty is pure', (triple) => {
    expect(pairPenalty(triple)).toEqual(pairPenalty(triple))
  })

  fcTest.prop([pathArb, foreignBodiesArb], withDefaults())(
    'selfPenalty is pure',
    (path, foreignBodies) => {
      expect(selfPenalty(path, foreignBodies)).toEqual(selfPenalty(path, foreignBodies))
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

  fcTest.prop([pathArb, foreignBodiesArb], withDefaults())(
    'selfPenalty totality, incl. zero-size rects, empty/single-point/zero-length paths',
    (path, foreignBodies) => {
      for (const n of selfPenalty(path, foreignBodies)) {
        expect(Number.isInteger(n)).toBe(true)
        expect(n).toBeGreaterThanOrEqual(0)
      }
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
