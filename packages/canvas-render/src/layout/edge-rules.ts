/**
 * Named routing-quality rules over side-choice, per the two-kind taxonomy
 * (package-canvas-render.md decision #10): a PREFERENCE rule affects
 * candidate ordering/tie-breaks only and is never traded against a penalty;
 * a PENALTY rule is a cost-tuple term with a declared lexicographic tier.
 * New routing feedback lands as one named rule + its own test here, not a
 * new branch in spatial-edges.ts.
 *
 * This file covers the PREFERENCE half of the taxonomy — candidate
 * generation for `rankedSidePairs` (spatial-edges.ts, a thin wrapper over
 * `composeSidePairs` below) plus the solver's adoption predicate
 * (`shouldAdoptCandidate`, the "incumbent-wins-ties" rule). Penalty-rule
 * extraction (pairScore/selfScore's cost terms in spatial-edges.ts) is a
 * separate, not-yet-landed slice — see the "penalty-rules-extraction"
 * follow-up.
 */

export type Side = 'top' | 'right' | 'bottom' | 'left'
export type Point = { readonly x: number; readonly y: number }
export type Rect = {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}
export type SidePair = { readonly fromSide: Side; readonly toSide: Side }

export function oppositeSide(side: Side): Side {
  switch (side) {
    case 'top':
      return 'bottom'
    case 'bottom':
      return 'top'
    case 'left':
      return 'right'
    case 'right':
      return 'left'
  }
}

/** Minimum shared-lane width for a facing pair to count as zero-bend. A
 * narrower window forces the aligned anchor into both nodes' corner zones —
 * the "straight" segment runs down the seam between two corners, or (since
 * anchors are placed by side fraction, not dragged into the window) is not
 * realized at all and degrades to a shallow diagonal. Such pairs read far
 * better through the one-bend perpendicular L. */
export const ZERO_LANE_MIN_OVERLAP_PX = 20

/** How close to a side's corner a slid anchor may sit, in px. Shared by the
 * facing-lane window computed here and by spatial-edges.ts's anchor-sliding
 * routing (`slideAlongSide`/`routeOrthogonal`), which must agree on the same
 * span so a routed segment never lands outside the window this promised. */
export const SLIDE_CORNER_INSET_PX = 10

/**
 * The tangent interval where BOTH facing sides can host an anchor (corner
 * insets applied), or undefined when it is narrower than the zero-bend
 * minimum. One producer for the ranking (is a zero-bend lane available?)
 * and the anchor alignment that realizes it.
 */
export function facingLaneWindow(
  fromRect: Rect,
  toRect: Rect,
  axis: 'h' | 'v',
): readonly [number, number] | undefined {
  const span = (r: Rect): readonly [number, number] =>
    axis === 'h'
      ? [
          r.y + Math.min(SLIDE_CORNER_INSET_PX, r.h / 2),
          r.y + r.h - Math.min(SLIDE_CORNER_INSET_PX, r.h / 2),
        ]
      : [
          r.x + Math.min(SLIDE_CORNER_INSET_PX, r.w / 2),
          r.x + r.w - Math.min(SLIDE_CORNER_INSET_PX, r.w / 2),
        ]
  const [aLo, aHi] = span(fromRect)
  const [bLo, bHi] = span(toRect)
  const lo = Math.max(aLo, bLo)
  const hi = Math.min(aHi, bHi)
  return hi - lo >= ZERO_LANE_MIN_OVERLAP_PX ? [lo, hi] : undefined
}

function facingSpansOverlap(fromRect: Rect, toRect: Rect, axis: 'h' | 'v'): boolean {
  return facingLaneWindow(fromRect, toRect, axis) !== undefined
}

/** The geometric situation a side-pair ranking is chosen from. */
export interface PreferenceRuleContext {
  readonly dx: number
  readonly dy: number
  readonly fromRect: Rect
  readonly toRect: Rect
  readonly crowd: (end: 'from' | 'to', side: Side) => number
}

/**
 * dominant-axis-first: the fixed tie-break every candidate-generating rule
 * below defers to — the axis with the larger absolute center offset goes
 * first; an exact tie (|dx| === |dy|) prefers horizontal. A pure ordering
 * helper, never a candidate source on its own, so its SIDE_PREFERENCE_RULES
 * entry is a 'tiebreak' (consulted by sibling rules), not a 'candidates'
 * generator.
 */
export function dominantAxisOrder<T>(
  dx: number,
  dy: number,
  horizontalFirst: T,
  verticalFirst: T,
): readonly [T, T] {
  return Math.abs(dx) >= Math.abs(dy)
    ? [horizontalFirst, verticalFirst]
    : [verticalFirst, horizontalFirst]
}

function hvSides(dx: number, dy: number): { h: Side; v: Side } {
  return { h: dx >= 0 ? 'right' : 'left', v: dy >= 0 ? 'bottom' : 'top' }
}

/**
 * Whether the two sides on `axis` genuinely face each other: boxes that
 * interpenetrate along the facing axis (from's leading edge past to's
 * trailing edge) would route the "straight" segment backwards into the
 * overlap, so this gates that degenerate case out ahead of the lane-width
 * check.
 */
function facingGapOk(ctx: PreferenceRuleContext, axis: 'h' | 'v'): boolean {
  const { h, v } = hvSides(ctx.dx, ctx.dy)
  return axis === 'h'
    ? h === 'right'
      ? ctx.fromRect.x + ctx.fromRect.w <= ctx.toRect.x
      : ctx.toRect.x + ctx.toRect.w <= ctx.fromRect.x
    : v === 'bottom'
      ? ctx.fromRect.y + ctx.fromRect.h <= ctx.toRect.y
      : ctx.toRect.y + ctx.toRect.h <= ctx.fromRect.y
}

/** A named routing-quality rule: either a candidate generator consumed by
 * `composeSidePairs`, or a pure ordering/adoption helper consulted by
 * sibling rules or the solver (declared here for discoverability + its own
 * test, but never concatenated directly). */
export type PreferenceRule =
  | {
      readonly kind: 'candidates'
      readonly name: string
      readonly generate: (ctx: PreferenceRuleContext) => readonly SidePair[]
    }
  | { readonly kind: 'tiebreak'; readonly name: string }

/**
 * zero-bend-facing-first: a facing opposing pair whose spans share a lane
 * at least ZERO_LANE_MIN_OVERLAP_PX wide, and whose gap is valid (not
 * interpenetrating), routes as one straight segment — ranked ahead of
 * everything else. Ordered dominant-axis-first when both axes qualify.
 */
const zeroBendFacingFirst = {
  kind: 'candidates' as const,
  name: 'zero-bend-facing-first',
  generate: (ctx: PreferenceRuleContext): readonly SidePair[] => {
    const { h, v } = hvSides(ctx.dx, ctx.dy)
    const opposingH: SidePair = { fromSide: h, toSide: oppositeSide(h) }
    const opposingV: SidePair = { fromSide: v, toSide: oppositeSide(v) }
    const zeroH = facingGapOk(ctx, 'h') && facingSpansOverlap(ctx.fromRect, ctx.toRect, 'h')
    const zeroV = facingGapOk(ctx, 'v') && facingSpansOverlap(ctx.fromRect, ctx.toRect, 'v')
    const [pairFirst, pairSecond] = dominantAxisOrder(ctx.dx, ctx.dy, opposingH, opposingV)
    const [okFirst, okSecond] = dominantAxisOrder(ctx.dx, ctx.dy, zeroH, zeroV)
    const zero: SidePair[] = []
    if (okFirst) zero.push(pairFirst)
    if (okSecond) zero.push(pairSecond)
    return zero
  },
}

/**
 * l-pair-crowding-tie-break: for a genuinely diagonal offset, the two
 * perpendicular L-pairs reach the target with one bend. Ties (equal
 * crowding, including the "no crowd function" default) keep the
 * dominant-axis order via `Array.prototype.sort`'s stability; otherwise the
 * less-crowded side wins, so a departure prefers a side other edges have
 * not already claimed.
 */
const lPairCrowdingTieBreak = {
  kind: 'candidates' as const,
  name: 'l-pair-crowding-tie-break',
  generate: (ctx: PreferenceRuleContext): readonly SidePair[] => {
    if (ctx.dx === 0 || ctx.dy === 0) return []
    const { h, v } = hvSides(ctx.dx, ctx.dy)
    const l1: SidePair = { fromSide: h, toSide: oppositeSide(v) }
    const l2: SidePair = { fromSide: v, toSide: oppositeSide(h) }
    const crowding = (p: SidePair) => ctx.crowd('from', p.fromSide) + ctx.crowd('to', p.toSide)
    const [first, second] = dominantAxisOrder(ctx.dx, ctx.dy, l1, l2)
    return [first, second].sort((a, b) => crowding(a) - crowding(b))
  },
}

/**
 * u-hook-when-degenerate: same-axis interpenetrating boxes with no
 * zero-bend pair, no L-pair (collinear offset), and no gap-valid opposing
 * pair at all — a same-side U-hook over the shared side is the sane
 * default, ranked ahead of the invalid opposing fallbacks. Any valid
 * alternative suppresses it.
 */
const uHookWhenDegenerate = {
  kind: 'candidates' as const,
  name: 'u-hook-when-degenerate',
  generate: (ctx: PreferenceRuleContext): readonly SidePair[] => {
    const { h } = hvSides(ctx.dx, ctx.dy)
    const zero = zeroBendFacingFirst.generate(ctx)
    const ls = lPairCrowdingTieBreak.generate(ctx)
    const anyGapValid = facingGapOk(ctx, 'h') || facingGapOk(ctx, 'v')
    if (zero.length !== 0 || ls.length !== 0 || anyGapValid) return []
    const across: Side = Math.abs(ctx.dx) >= Math.abs(ctx.dy) ? (ctx.dy > 0 ? 'bottom' : 'top') : h
    return [
      { fromSide: across, toSide: across },
      { fromSide: oppositeSide(across), toSide: oppositeSide(across) },
    ]
  },
}

/**
 * gap-valid-opposing-before-invalid: both opposing pairs (dominant-axis
 * order as the baseline) always stay in the ranking, so it is total, but a
 * pair whose facing gap failed the interpenetration check routes backwards
 * through the overlap — it is offered only after every gap-valid
 * alternative.
 */
const gapValidOpposingBeforeInvalid = {
  kind: 'candidates' as const,
  name: 'gap-valid-opposing-before-invalid',
  generate: (ctx: PreferenceRuleContext): readonly SidePair[] => {
    const { h, v } = hvSides(ctx.dx, ctx.dy)
    const opposingH: SidePair = { fromSide: h, toSide: oppositeSide(h) }
    const opposingV: SidePair = { fromSide: v, toSide: oppositeSide(v) }
    const ordered = dominantAxisOrder(ctx.dx, ctx.dy, opposingH, opposingV)
    const gapOk = (p: SidePair) => facingGapOk(ctx, p.fromSide === h ? 'h' : 'v')
    return [...ordered.filter(gapOk), ...ordered.filter((p) => !gapOk(p))]
  },
}

const dominantAxisFirst = { kind: 'tiebreak' as const, name: 'dominant-axis-first' }
const incumbentWinsTies = { kind: 'tiebreak' as const, name: 'incumbent-wins-ties' }

/**
 * The declared, ordered PREFERENCE-rule catalog (decision #10). Candidate
 * generation (`composeSidePairs`) composes only the 'candidates'-kind
 * entries, in this order; 'tiebreak' entries are consulted directly by
 * name (`dominantAxisOrder`, `shouldAdoptCandidate`) rather than
 * concatenated, since they never independently contribute a candidate.
 */
export const SIDE_PREFERENCE_RULES: readonly PreferenceRule[] = [
  zeroBendFacingFirst,
  dominantAxisFirst,
  lPairCrowdingTieBreak,
  uHookWhenDegenerate,
  gapValidOpposingBeforeInvalid,
  incumbentWinsTies,
]

/**
 * The composed, deduplicated (first-wins) side-pair ranking over every
 * 'candidates'-kind rule in `rules`' declared order. `rankedSidePairs`
 * (spatial-edges.ts) is a thin wrapper over the default `SIDE_PREFERENCE_RULES`
 * composition; the `rules` override exists so a test can compose over a
 * subset (e.g. one rule removed) without duplicating this loop.
 */
export function composeSidePairs(
  ctx: PreferenceRuleContext,
  rules: readonly PreferenceRule[] = SIDE_PREFERENCE_RULES,
): readonly SidePair[] {
  const seen = new Set<string>()
  const ranked: SidePair[] = []
  for (const rule of rules) {
    if (rule.kind !== 'candidates') continue
    for (const pair of rule.generate(ctx)) {
      const key = `${pair.fromSide} ${pair.toSide}`
      if (seen.has(key)) continue
      seen.add(key)
      ranked.push(pair)
    }
  }
  return ranked
}

/**
 * incumbent-wins-ties: the solver's adoption predicate — a trial candidate
 * replaces the incumbent only on a STRICT cost decrease, never a tie, so a
 * deterministic lexicographic compare cannot oscillate between two
 * equal-cost configurations. Generic over the cost type so this rule never
 * needs to know the penalty tuple's shape.
 */
export function shouldAdoptCandidate<T>(
  candidateCost: T,
  incumbentCost: T,
  lessCost: (a: T, b: T) => boolean,
): boolean {
  return lessCost(candidateCost, incumbentCost)
}
