/**
 * Named routing-quality rules over side-choice, per the two-kind taxonomy
 * (package-canvas-render.md decision #10): a PREFERENCE rule affects
 * candidate ordering/tie-breaks only and is never traded against a penalty;
 * a PENALTY rule is a cost-tuple term with a declared lexicographic tier.
 * New routing feedback lands as one named rule + its own test here, not a
 * new branch in spatial-edges.ts.
 *
 * This file covers both halves of the taxonomy: candidate generation for
 * `rankedSidePairs` (spatial-edges.ts, a thin wrapper over `composeSidePairs`
 * below) plus the solver's adoption predicate (`shouldAdoptCandidate`, the
 * "incumbent-wins-ties" rule) are the PREFERENCE half; `PENALTY_RULES` below
 * is the PENALTY half — `pairScore` (spatial-edges.ts) and `selfPenalty`
 * compose over it to build the cost tuple `optimizeSideChoices` compares.
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
  // The `min` is a clamp for a side shorter than twice the inset, and its
  // exact form is unobservable: such a side collapses to a point or inverts
  // either way, and neither can clear the zero-bend minimum. It is here so
  // the span never runs backwards, not to change an answer.
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
    // `okSecond` is unreachable, and the pair is kept because the SYMMETRY is
    // the rule: a horizontal zero-bend needs an x-gap plus a y-span overlap
    // and a vertical one the mirror, so a pair with a gap on one axis has no
    // span overlap on it and at most one can hold — and whichever does is the
    // dominant axis, since an axis with a gap carries the larger centre
    // offset. Pinned by a property beside the examples in `edge-rules.test.ts`
    // (at most one pair, ever), so a change that makes both reachable fails
    // there rather than silently relying on this branch never having run.
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
    // The `'bottom'` arm is unreachable as the rule stands, and the ternary
    // keeps it because the ARM is what says which side the hook goes over —
    // deleting it would leave a bare `'top'` that reads as a coincidence.
    // Reaching it needs `dy > 0` together with `|dx| >= |dy|`, and getting
    // this far already needs one offset to be zero (the L-pair rule steps
    // aside for nothing else), so `dy` is zero whenever the inner test runs.
    // A future rule that stops requiring a collinear offset would open it.
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

/** `rect`'s border on `side`, as a 2-point segment `inkAlongRects` can walk. */
function sideSegment(rect: Rect, side: Side): readonly [Point, Point] {
  switch (side) {
    case 'top':
      return [
        { x: rect.x, y: rect.y },
        { x: rect.x + rect.w, y: rect.y },
      ]
    case 'bottom':
      return [
        { x: rect.x, y: rect.y + rect.h },
        { x: rect.x + rect.w, y: rect.y + rect.h },
      ]
    case 'left':
      return [
        { x: rect.x, y: rect.y },
        { x: rect.x, y: rect.y + rect.h },
      ]
    case 'right':
      return [
        { x: rect.x + rect.w, y: rect.y },
        { x: rect.x + rect.w, y: rect.y + rect.h },
      ]
  }
}

/**
 * Whether `rect`'s WHOLE `side` border passes through `other`'s STRICT
 * interior for some positive-length stretch. The SPAN, not the side
 * midpoint: a same-side U-hook anchor is placed by `computeAnchorsFor`'s
 * fan-out, so a single point can miss an occlusion the span sees. Runs
 * `inkAlongRects`'s ink-length loop (the same "strictly between the two
 * borders" predicate `endpoint-body-ink` prices) over one synthetic segment
 * rather than adding a second span-overlap implementation.
 */
function sideSpanEntersRect(rect: Rect, side: Side, other: Rect): boolean {
  return (
    inkAlongRects(
      sideSegment(rect, side),
      [other],
      (fixed, near, far) => near < fixed && fixed < far,
    ) > 0
  )
}

/**
 * u-hook-span-exposed-first: among the four same-side U-hook candidates (a
 * departure and arrival on the SAME compass side of each rect — the
 * fallback that hooks OVER everything when the ranked vocabulary above
 * offers nothing usable, or loses on cost to some other candidate), demote
 * one whose DEPARTURE side border runs through the target's strict interior
 * behind one that does not.
 *
 * Departure-only, NOT symmetric with the arrival end: a departure stub
 * draws in a straight line off its own border, so a departure span through
 * the target's body is real evidence of the ink `endpoint-body-ink` prices;
 * the routed geometry reaches an arrival anchor from OUTSIDE the target,
 * so an arrival side's border overlapping the source proves nothing. A
 * symmetric version also flips edge-side-occlusion.test.ts's "far endpoint
 * overlapping the anchor is not an occluder" pin.
 *
 * MANDATORY EXCLUSION, same predicate as endpoint-body-ink and
 * deriveDefaultSides's occlusion filter: a rect that `fullyContains` the
 * other endpoint (a group frame around its member) never taints a side —
 * every hook out of the contained node runs through the container equally,
 * which says nothing about which side to prefer.
 *
 * Always total (returns all four, only reordered) and placed LAST among
 * the 'candidates' rules: `gap-valid-opposing-before-invalid` above it
 * already guarantees a non-empty ranking, so this rule can never become
 * `pairs[0]` — it only refines the tail `candidatesFor` (spatial-edges.ts)
 * tries once every ranked-vocabulary pair has been exhausted.
 */
const uHookSpanExposedFirst = {
  kind: 'candidates' as const,
  name: 'u-hook-span-exposed-first',
  generate: (ctx: PreferenceRuleContext): readonly SidePair[] => {
    const hooks: readonly SidePair[] = (['top', 'right', 'bottom', 'left'] as const).map(
      (side) => ({ fromSide: side, toSide: side }),
    )
    if (fullyContains(ctx.toRect, ctx.fromRect)) return hooks
    const taints = (p: SidePair) => sideSpanEntersRect(ctx.fromRect, p.fromSide, ctx.toRect)
    return [...hooks.filter((p) => !taints(p)), ...hooks.filter(taints)]
  },
}

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
  uHookSpanExposedFirst,
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

/** Quarter-pixel quantization: every PENALTY_RULES term is integral, so
 * candidate comparison is exact integer arithmetic — no float tie can
 * differ between platforms (see edge-crossing-sweep.ts's matching
 * COST_QUANTUM, which the narrow phase quantizes with independently). */
export const COST_QUANTUM = 4

/** Direction changes along a polyline, ignoring repeated/collinear points. */
export function bendCount(path: readonly Point[]): number {
  let bends = 0
  let lastDir: string | undefined
  for (let i = 1; i < path.length; i++) {
    const dx = Math.sign((path[i] as Point).x - (path[i - 1] as Point).x)
    const dy = Math.sign((path[i] as Point).y - (path[i - 1] as Point).y)
    if (dx === 0 && dy === 0) continue
    const dir = `${dx},${dy}`
    if (lastDir !== undefined && dir !== lastDir) bends++
    lastDir = dir
  }
  return bends
}

/**
 * A named PENALTY rule (decision #10): a cost-tuple term with a declared
 * lexicographic tier. `pairTerm` reads this rule's contribution out of the
 * narrow-phase [overlap, illegible, crossings] triple that
 * `scoreSegmentPair`/`buildPairwiseScores` (edge-crossing-sweep.ts, the
 * SINGLE producer of pair geometry) already computed — a rule with no pair
 * contribution returns 0 without touching the triple. `selfTerm` computes
 * this rule's contribution from one routed path's own geometry plus the
 * bystander rects it might tunnel through; a rule with no self contribution
 * returns 0 without walking the path. Every rule's `tier` is also its slot
 * index into the composed cost array — enforced by the `PENALTY_RULES`
 * tier-order pin in edge-rules.test.ts, not by this type. `selfTerm`'s third
 * parameter is every node's border rect (INCLUDING the path's own endpoints
 * — unlike `foreignBodies`, which deliberately excludes them), for rules
 * that price ink drawn on a node's OUTLINE rather than through its interior.
 * The fourth parameter is the edge's OWN endpoint rects (`from`/`to` node
 * borders only), for rules that price ink through an endpoint's own
 * interior — the complementary case `foreignBodies` cannot see, since it
 * deliberately excludes the edge's own endpoints for the tunnel check.
 */
export type PenaltyRule = {
  readonly name: string
  readonly tier: number
  readonly pairTerm: (triple: readonly [number, number, number]) => number
  readonly selfTerm: (
    path: readonly Point[],
    foreignBodies: readonly Rect[],
    nodeBorders: readonly Rect[],
    endpointRects: readonly Rect[],
  ) => number
}

/**
 * Whether `outer` fully contains `inner` (inclusive borders). A rect that
 * FULLY CONTAINS an edge's endpoint node (a group frame around its member)
 * can never be treated as an obstacle to route around — every route out of
 * the contained node still has to cross it — so both `deriveDefaultSides`'s
 * occlusion filter (spatial-edges.ts) and `endpoint-body-ink`'s exclusion
 * below reuse this SAME predicate rather than each inventing their own.
 */
export function fullyContains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  )
}

/**
 * The one COST_QUANTUM rounding every ink term measures in. Sub-quantum
 * differences are rounding wobble, not geometry: anchors land on fractions
 * (a slid anchor can sit at 233.333...px), so terms that compare or subtract
 * coordinates must agree on where the grid is.
 */
function quantize(n: number): number {
  return Math.round(n * COST_QUANTUM)
}

/**
 * Quantized length of an axis-aligned path's ink lying along `rects`, in the
 * COST_QUANTUM-quantized integer space every ink-length term is measured in
 * (so the term is integral by construction). `qualifies` is the ONE thing
 * ink-length rules differ by: given a segment's fixed coordinate and the
 * rect's two borders on that axis, whether the segment counts —
 * border-tracing passes "on either border", endpoint-body-ink "strictly
 * between them". Both take the single per-axis condition rather than two
 * independent checks, which is what stops a zero-extent rect (near === far)
 * from being charged twice for the same segment.
 */
function inkAlongRects(
  path: readonly Point[],
  rects: readonly Rect[],
  qualifies: (fixed: number, near: number, far: number) => boolean,
): number {
  const q = quantize
  let total = 0
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] as Point
    const b = path[i] as Point
    const horizontal = a.y === b.y
    if (!horizontal && a.x !== b.x) continue
    for (const r of rects) {
      const near = horizontal ? r.y : r.x
      const far = horizontal ? r.y + r.h : r.x + r.w
      if (!qualifies(q(horizontal ? a.y : a.x), q(near), q(far))) continue
      const p1 = horizontal ? a.x : a.y
      const p2 = horizontal ? b.x : b.y
      const lo = Math.max(q(Math.min(p1, p2)), q(horizontal ? r.x : r.y))
      const hi = Math.min(q(Math.max(p1, p2)), q(horizontal ? r.x + r.w : r.y + r.h))
      if (hi > lo) total += hi - lo
    }
  }
  return total
}

/**
 * overlap-and-intrusion: collinear axis-aligned overlap (a parallel overlap
 * has no crossing point, so a line jump cannot express it) plus, from a
 * single path's own geometry, retracing its own ink (the doubled-line
 * arrival a facing-away side produces when the connector overshoots the
 * entry stub through the node body) and tunnelling through a bystander
 * node's raw body (a line through a node reads as though it connects that
 * node, which no line jump can express). Heaviest tier: it outranks even an
 * edge crossing.
 */
const overlapAndIntrusion: PenaltyRule = {
  name: 'overlap-and-intrusion',
  tier: 0,
  pairTerm: (triple) => triple[0],
  selfTerm: (path, foreignBodies) => {
    let overlap = 0
    // Quantized once per POINT rather than per comparison: the retrace loop
    // below is quadratic in the segment count and re-derived the same six
    // values for every pair. `quantize` is pure, so the sums are unchanged.
    const qx: number[] = []
    const qy: number[] = []
    for (const p of path) {
      qx.push(quantize(p.x))
      qy.push(quantize(p.y))
    }
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1] as Point
      const b = path[i] as Point
      // Only an axis-aligned segment can tunnel, and only through a body
      // whose OTHER axis strictly contains it — the same reject the router
      // and the grid search already apply. A diagonal or zero-length
      // segment scores nothing against any body, so it skips the loop
      // entirely rather than computing four bounds per obstacle to find
      // that out. Boundary grazing stays excluded: an anchor ON a
      // neighbour's border or a segment riding the margin band is
      // bestCandidate's business, not a tunnel.
      const horizontal = a.y === b.y && a.x !== b.x
      const vertical = a.x === b.x && a.y !== b.y
      if (!horizontal && !vertical) continue
      for (const r of foreignBodies) {
        if (horizontal) {
          if (a.y <= r.y || a.y >= r.y + r.h) continue
          const minX = Math.max(Math.min(a.x, b.x), r.x)
          const maxX = Math.min(Math.max(a.x, b.x), r.x + r.w)
          if (maxX > minX) overlap += quantize(maxX - minX)
        } else {
          if (a.x <= r.x || a.x >= r.x + r.w) continue
          const minY = Math.max(Math.min(a.y, b.y), r.y)
          const maxY = Math.min(Math.max(a.y, b.y), r.y + r.h)
          if (maxY > minY) overlap += quantize(maxY - minY)
        }
      }
    }
    for (let i = 1; i < path.length; i++) {
      for (let j = i + 1; j < path.length; j++) {
        const ax1 = qx[i - 1] as number
        const ay1 = qy[i - 1] as number
        const ax2 = qx[i] as number
        const ay2 = qy[i] as number
        const bx1 = qx[j - 1] as number
        const by1 = qy[j - 1] as number
        const bx2 = qx[j] as number
        const by2 = qy[j] as number
        if (ax1 === ax2 && bx1 === bx2 && ax1 === bx1) {
          const lo = Math.max(Math.min(ay1, ay2), Math.min(by1, by2))
          const hi = Math.min(Math.max(ay1, ay2), Math.max(by1, by2))
          if (hi > lo) overlap += hi - lo
        } else if (ay1 === ay2 && by1 === by2 && ay1 === by1) {
          const lo = Math.max(Math.min(ax1, ax2), Math.min(bx1, bx2))
          const hi = Math.min(Math.max(ax1, ax2), Math.max(bx1, bx2))
          if (hi > lo) overlap += hi - lo
        }
      }
    }
    return overlap
  },
}

/** illegibility: a transversal crossing too close to a segment end to
 * render a legible jump arc. Pair-only — no path retraces "close to its own
 * end" in a way this tier is meant to capture. */
const illegibility: PenaltyRule = {
  name: 'illegibility',
  tier: 1,
  pairTerm: (triple) => triple[1],
  selfTerm: () => 0,
}

/** crossings: total transversal crossings between two routed paths.
 * Pair-only, and already short-circuited by `scoreSegmentPair` for a
 * collinear overlapping pair (see edge-crossing-sweep.ts). */
const crossings: PenaltyRule = {
  name: 'crossings',
  tier: 2,
  pairTerm: (triple) => triple[2],
  selfTerm: () => 0,
}

/**
 * border-tracing: a routed segment running collinear with AND overlapping a
 * node's border — ink drawn on top of an outline reads as though the edge
 * merges into that box. Self-only; `nodeBorders` includes the path's own
 * endpoint rects (unlike `foreignBodies`, which excludes them for the
 * tunnel check) — the defect this rule exists to price is a segment riding
 * the SOURCE node's own border. A perpendicular departure/arrival only
 * touches its border at a point (zero-length overlap, costs 0); only
 * positive overlap length is priced.
 *
 * Tier 3, BELOW crossings, because this rule is evaluated against the
 * optimizer's unaligned TRIAL paths (the pre-`slideAlongSide`
 * representation used only for ranking candidates — see
 * `computeAnchorsFor`'s `align` parameter), whose anchor placement can
 * coincidentally run a detour segment along a bystander's border for a
 * real stretch: a false signal a genuine CROSSING never produces. At tier 1
 * that artifact out-ranked a real crossing and the optimizer adopted a
 * strictly worse rendered route (pinned by edge-lane-rank.test.ts's
 * sweep-rank scenario). Below crossings it still repairs the border-riding
 * defect, whose lower tiers are all-zero for every side-pair option, so the
 * lexicographic comparison falls through to this tier as the decisive one.
 * It must also stay ABOVE endpoint-body-ink: ranked below it, the optimizer
 * trades this rule's defect for that one (see endpoint-body-ink's comment).
 */
const borderTracing: PenaltyRule = {
  name: 'border-tracing',
  tier: 4,
  pairTerm: () => 0,
  selfTerm: (path, _foreignBodies, nodeBorders) =>
    inkAlongRects(path, nodeBorders, (fixed, near, far) => fixed === near || fixed === far),
}

/**
 * endpoint-body-ink: ink drawn STRICTLY INSIDE an edge's OWN endpoint
 * node's body — the departure/arrival stub cutting through the near or far
 * endpoint's interior, which overlapping nodes provoke (a stub leaving one
 * node's border can land inside a neighbour's overlapping body). Self-only,
 * and the exact interior complement of border-tracing: that rule prices a
 * segment ON a border, this one a segment STRICTLY BETWEEN a rect's two
 * borders — mutually exclusive in quantized space, so the same segment is
 * never charged by both (pinned by the per-(segment,rect) complementarity
 * property).
 *
 * `foreignBodies`/`overlap-and-intrusion` already price a tunnel through a
 * FOREIGN node's body; this rule exists only because that check deliberately
 * excludes an edge's own endpoints (a rect containing an endpoint can never
 * be routed around) — but that reasoning only rules out routing AROUND the
 * endpoint's rect, not ink running through it beyond the anchor point.
 *
 * MANDATORY EXCLUSION: a rect that `fullyContains` another endpoint rect (a
 * group frame around its member) is skipped — every route out of the
 * contained node crosses the container, so pricing it would make the edge
 * permanently 'repairable' with no better option, and the optimizer would
 * churn on it every layout. The exclusion test is deliberately ASYMMETRIC
 * (`fullyContains(r, other) && !fullyContains(other, r)`), not a bare
 * `fullyContains(r, other)`: two numerically-equal rects (a self-loop, or
 * two same-size fully-overlapping nodes — the exact worst-case overlap this
 * rule exists to price) satisfy `fullyContains` in BOTH directions under its
 * inclusive `<=`/`>=` comparisons, so the symmetric test excluded BOTH rects
 * and silently zeroed the penalty for that case. Same asymmetric idiom as
 * `tidy.ts`'s `isRoot` group-containment tie-break.
 *
 * Tier 4, BELOW border-tracing, for the same trial-path-artifact reason
 * border-tracing itself was demoted off tier 1 (see its own comment). Ranked
 * ABOVE border-tracing instead, the optimizer buys a few px of border ink
 * back with ~120px of interior ink — trading one visible-ink defect for the
 * other rather than clearing both. Clearing both inside the optimizer's
 * pass budget is a matter of candidate ORDER, not more passes: see
 * `u-hook-span-exposed-first` above.
 */
/**
 * Exported because `bestCandidate` (`spatial-edges.ts`) ranks by this ONE
 * term directly rather than the whole cost tuple: inside a single side pair
 * it is choosing between paths, so the inter-edge terms do not apply and
 * the foreign-body ones are already the clearance tiers it sorts within.
 */
/**
 * Length of `path` running STRICTLY between a rect's two borders — ink laid
 * over content rather than over an existing stroke. A rect that fully
 * contains another in the same list is dropped: a group frame is drawn
 * around its members, and a route legitimately inside it is not tunnelling
 * through anything a reader would notice.
 *
 * Exported because `spatial-edges.ts` asks the same question of a candidate
 * path directly, rather than through the whole cost tuple: inside a single
 * side pair it is choosing between paths, so the inter-edge terms do not
 * apply. Two producers of "how much ink is inside a box" is exactly the
 * drift this package has a one-producer-per-geometry rule about.
 */
export function interiorInkThrough(path: readonly Point[], rects: readonly Rect[]): number {
  return inkAlongRects(
    path,
    rects.filter(
      (r) =>
        !rects.some((other) => other !== r && fullyContains(r, other) && !fullyContains(other, r)),
    ),
    (fixed, near, far) => near < fixed && fixed < far,
  )
}

export const endpointBodyInk: PenaltyRule = {
  name: 'endpoint-body-ink',
  tier: 3,
  pairTerm: () => 0,
  selfTerm: (path, _foreignBodies, _nodeBorders, endpointRects) =>
    interiorInkThrough(path, endpointRects),
}

/** Quantized per-axis direction sign, in the same COST_QUANTUM space every
 * other ink-length term is measured in — anchors are fractional (a slid
 * anchor can land at e.g. 233.333...px), so a raw `Math.sign` would read a
 * sub-quarter-pixel rounding wobble as a reversal. */
function quantizedSign(a: number, b: number): number {
  return Math.sign(quantize(b) - quantize(a))
}

/** Direction reversals per axis along a polyline: a segment whose sign on
 * an axis is opposite to the last NON-ZERO sign this walk saw on that same
 * axis. Axes are tracked independently (unlike `bendCount`, which combines
 * both axes into one direction pair) — a Z zig-zags through two different
 * combined directions without ever undoing either axis alone, so it must
 * read 0 here while still reading 2 bends. */
function reversalCount(path: readonly Point[]): number {
  let reversals = 0
  let lastSignX: number | undefined
  let lastSignY: number | undefined
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] as Point
    const b = path[i] as Point
    const sx = quantizedSign(a.x, b.x)
    const sy = quantizedSign(a.y, b.y)
    if (sx !== 0) {
      if (lastSignX !== undefined && sx === -lastSignX) reversals++
      lastSignX = sx
    }
    if (sy !== 0) {
      if (lastSignY !== undefined && sy === -lastSignY) reversals++
      lastSignY = sy
    }
  }
  return reversals
}

/**
 * path-reversal: a routed path that doubles back on itself — moving up
 * then down, or left then right, on the SAME axis. This is invisible to
 * every tier above it: the two retrograde segments of the defect this rule
 * was written for sit a few px apart (never collinear), so
 * overlap-and-intrusion's self-retrace check never fires, and there is no
 * foreign-body ink and no crossing either. A route like this reads on
 * screen as a small knot hanging off the node, independent of and often
 * shorter than a clean alternative — a length-based term would keep
 * choosing it, so this rule counts reversals, not length.
 *
 * Self-only, and REPAIRABLE (unlike its `realized-bends` neighbour): a
 * deliberate same-side U-hook over an interpenetrating pair (see
 * `u-hook-when-degenerate`) also reverses once by construction, so this
 * tier alone cannot forbid a reversal outright — it can only rank a
 * reversal-free route ahead of a reversing one when both are otherwise
 * candidates, which is exactly what makes the knot repairable while a
 * genuinely unavoidable hook still settles.
 *
 * Tier placement is evidence-driven, same discipline as border-tracing and
 * endpoint-body-ink above: on the canvas this rule exists to fix, every
 * tier below `endpoint-body-ink` is zero for the settled configuration
 * (`hasRepairableProblem` was false, so the optimizer never evaluated a
 * single candidate), so the rule has to sit BELOW the last declared tier to
 * change the outcome at all. It sits directly above `realized-bends` —
 * the lowest repairable slot — rather than higher: this file's own history
 * (border-tracing tier 1 -> 3, endpoint-body-ink placed below it) is a
 * rule scored against the optimizer's UNALIGNED TRIAL paths, where a
 * higher tier risks an artifact outranking a real signal; the lowest
 * repairable slot is the least aggressive placement that still fixes the
 * defect.
 */
const pathReversal: PenaltyRule = {
  name: 'path-reversal',
  tier: 5,
  pairTerm: () => 0,
  selfTerm: (path) => reversalCount(path),
}

/** realized-bends: direction changes along ONE routed path. Self-only, and
 * deliberately the LAST tier — the optimizer's short-circuit
 * (`hasRepairableProblem`) and worst-offender filter both ignore it, since
 * a configuration with no overlap/illegibility/crossings/reversal is
 * already healthy and reshuffling it purely to shave bends is churn, not
 * repair. */
const realizedBends: PenaltyRule = {
  name: 'realized-bends',
  tier: 6,
  pairTerm: () => 0,
  selfTerm: (path) => bendCount(path),
}

/**
 * The declared, tier-ordered PENALTY-rule catalog (decision #10). Index
 * MUST equal `tier` for every entry — pinned in edge-rules.test.ts — since
 * every composition helper below writes a rule's contribution at
 * `cost[rule.tier]`, never at its array position.
 */
export const PENALTY_RULES: readonly PenaltyRule[] = [
  overlapAndIntrusion,
  illegibility,
  crossings,
  endpointBodyInk,
  borderTracing,
  pathReversal,
  realizedBends,
]

/** The all-zero cost, sized to `rules` — derived from the declared list
 * (`rules.map`), never a hardcoded array length. */
export function zeroPenalty(rules: readonly PenaltyRule[] = PENALTY_RULES): number[] {
  return rules.map(() => 0)
}

/**
 * `pairScore`'s composition step (spatial-edges.ts): map the narrow
 * phase's summed [overlap, illegible, crossings] triple into a full cost
 * array, one rule per declared tier.
 */
export function pairPenalty(
  triple: readonly [number, number, number],
  rules: readonly PenaltyRule[] = PENALTY_RULES,
): number[] {
  const cost = zeroPenalty(rules)
  for (const rule of rules) cost[rule.tier] = rule.pairTerm(triple)
  return cost
}

/**
 * The self half of the composition (`optimizeSideChoices`, spatial-edges.ts):
 * map one routed path's self-geometry into a full cost array, one rule per
 * declared tier. `nodeBorders` and `endpointRects` each default to `[]`
 * ("no border/endpoint ink declared") rather than falling back to
 * `foreignBodies` or to each other — a caller that passes none gets 0 from
 * `border-tracing`/`endpoint-body-ink`, exactly as if the rule did not
 * exist.
 */
export function selfPenalty(
  path: readonly Point[],
  foreignBodies: readonly Rect[],
  nodeBorders: readonly Rect[] = [],
  endpointRects: readonly Rect[] = [],
  rules: readonly PenaltyRule[] = PENALTY_RULES,
): number[] {
  const cost = zeroPenalty(rules)
  for (const rule of rules) {
    cost[rule.tier] = rule.selfTerm(path, foreignBodies, nodeBorders, endpointRects)
  }
  return cost
}

export function addCost(
  a: readonly number[],
  b: readonly number[],
  sign: 1 | -1,
  rules: readonly PenaltyRule[] = PENALTY_RULES,
): number[] {
  const out = zeroPenalty(rules)
  for (const rule of rules) out[rule.tier] = (a[rule.tier] ?? 0) + sign * (b[rule.tier] ?? 0)
  return out
}

/**
 * `addCost` into an existing array. For the one caller that sums hundreds
 * of pair terms into a single trial total (`evaluateTrial`, spatial-edges.ts):
 * a fresh seven-slot array per term was the bulk of a trial's bookkeeping.
 * `target` is the caller's own scratch copy, never a cost it shares.
 */
export function accumulateCost(
  target: number[],
  b: readonly number[],
  sign: 1 | -1,
  rules: readonly PenaltyRule[] = PENALTY_RULES,
): void {
  for (const rule of rules)
    target[rule.tier] = (target[rule.tier] ?? 0) + sign * (b[rule.tier] ?? 0)
}

/**
 * Lexicographic integer compare over the declared tiers, in TIER order
 * (sorted by `rule.tier`, so a caller passing an accidentally-reordered
 * `rules` array still compares correctly — only the canonical
 * `PENALTY_RULES` array itself is pinned to already be in tier order).
 */
export function lessCost(
  a: readonly number[],
  b: readonly number[],
  rules: readonly PenaltyRule[] = PENALTY_RULES,
): boolean {
  for (const rule of tierOrdered(rules)) {
    const av = a[rule.tier] ?? 0
    const bv = b[rule.tier] ?? 0
    if (av !== bv) return av < bv
  }
  return false
}

/**
 * Whether a configuration has a REPAIRABLE problem: any declared tier
 * BELOW the last one is nonzero. Generalizes the old "first three slots
 * zero" short-circuit — the last tier is realized-bends (pinned in
 * edge-rules.test.ts), and bends-only churn is deliberately excluded from
 * both `optimizeSideChoices`'s whole-config short-circuit and its
 * worst-offender contribution filter (spatial-edges.ts).
 */
export function hasRepairableProblem(
  cost: readonly number[],
  rules: readonly PenaltyRule[] = PENALTY_RULES,
): boolean {
  const ordered = tierOrdered(rules)
  const lastTier = ordered[ordered.length - 1]?.tier ?? 0
  return rules.some((r) => r.tier < lastTier && (cost[r.tier] ?? 0) !== 0)
}

/** `rules` sorted by tier, computed once per rule list: the search compares
 * costs hundreds of thousands of times per layout and re-sorting the same
 * seven-entry list on every compare was a measurable share of it. */
const tierOrderCache = new WeakMap<readonly PenaltyRule[], readonly PenaltyRule[]>()
function tierOrdered(rules: readonly PenaltyRule[]): readonly PenaltyRule[] {
  let ordered = tierOrderCache.get(rules)
  if (ordered === undefined) {
    ordered = [...rules].sort((x, y) => x.tier - y.tier)
    tierOrderCache.set(rules, ordered)
  }
  return ordered
}
