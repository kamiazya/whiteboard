// The pairwise crossing/overlap scorer's broad phase. optimizeSideChoices
// needs the ConfigCost contribution of every edge pair once per
// optimization run; a full double loop is O(E^2) narrow-phase calls and is
// what forced the 40-edge gate. Segments are axis-aligned-dominant here,
// so a sweep-and-prune over x with a y-interval gate prunes almost every
// non-interacting pair while calling the EXACT same narrow phase for the
// survivors — equality with the full pairwise scan is by construction, not
// by approximation.
//
// Deliberately NOT Bentley-Ottmann: this workload's normal case is B-O's
// degenerate case (lane fan-out shares endpoints at anchors, lane
// corridors are collinear overlapping segments scored by quantized LENGTH
// — which intersection events do not natively produce — and vertical
// segments are everywhere). Sweep-and-prune has no float-keyed event
// ordering to create cross-platform ties: per-pair integer tuples are
// summed per pair key, enumeration-order-independent.

import type { Point } from './edge-geometry.js'
import { EDGE_JUMP_RADIUS_PX } from './edge-jumps.js'
import type { RoutingBudget } from './routing-budget.js'

/** Matches `edge-ink.ts`'s COST_QUANTUM discipline (quarter-pixel integers). */
const COST_QUANTUM = 4

/**
 * Broad-phase bbox slack, in px. q(n) = round(n * 4) can rate two
 * coordinates equal when their raw values differ by just under a quantum
 * step, and a transversal crossing requires a genuinely shared point — so
 * any segment pair with a nonzero narrow-phase contribution has
 * intersecting bboxes after this inflation. Slack only ADDS candidates,
 * never removes one (the completeness lemma the differential property
 * pins).
 */
const BROAD_PHASE_SLACK_PX = 1 / COST_QUANTUM

/**
 * The narrow phase: one segment pair's [overlap, illegible, crossings]
 * contribution — extracted verbatim from pairScore's inner loop so the
 * sweep and the per-pair oracle cannot drift. Collinear axis-aligned
 * overlap short-circuits the crossing test for the pair, exactly like the
 * original `continue`.
 */
export function scoreSegmentPair(
  a1: Point,
  a2: Point,
  b1: Point,
  b2: Point,
): readonly [number, number, number] {
  const q = (n: number) => Math.round(n * COST_QUANTUM)
  return scoreQuantizedSegmentPair(
    q(a1.x),
    q(a1.y),
    q(a2.x),
    q(a2.y),
    q(b1.x),
    q(b1.y),
    q(b2.x),
    q(b2.y),
  )
}

/** `EDGE_JUMP_RADIUS_PX + 1`, in COST_QUANTUM units. */
const CLEARANCE_Q = (EDGE_JUMP_RADIUS_PX + 1) * COST_QUANTUM

/**
 * The narrow phase on ALREADY-QUANTIZED integer coordinates — pure integer
 * arithmetic from here on, so a second implementation of it (a WGSL
 * kernel, a worker) can be held to bit-identical output. Quantizing first,
 * rather than only for the collinear branch, is what makes that true: a
 * crossing test on raw floats would let two endpoints a sub-quantum apart
 * count as a crossing here while scoring equal everywhere else. `t`/`u` stay exact because every comparison is done on
 * the cross-multiplied integers, never on the quotient.
 */
export function scoreQuantizedSegmentPair(
  ax1: number,
  ay1: number,
  ax2: number,
  ay2: number,
  bx1: number,
  by1: number,
  bx2: number,
  by2: number,
): readonly [number, number, number] {
  // Collinear axis-aligned overlap.
  if (ay1 === ay2 && by1 === by2 && ay1 === by1) {
    const lo = Math.max(Math.min(ax1, ax2), Math.min(bx1, bx2))
    const hi = Math.min(Math.max(ax1, ax2), Math.max(bx1, bx2))
    return [hi > lo ? hi - lo : 0, 0, 0]
  }
  if (ax1 === ax2 && bx1 === bx2 && ax1 === bx1) {
    const lo = Math.max(Math.min(ay1, ay2), Math.min(by1, by2))
    const hi = Math.min(Math.max(ay1, ay2), Math.max(by1, by2))
    return [hi > lo ? hi - lo : 0, 0, 0]
  }
  // Proper transversal crossing: t = tn/denom, u = un/denom, both strictly
  // inside (0, 1). Signs are normalized so the open-interval test is a
  // plain integer comparison.
  const dax = ax2 - ax1
  const day = ay2 - ay1
  const dbx = bx2 - bx1
  const dby = by2 - by1
  let denom = dax * dby - day * dbx
  if (denom === 0) return [0, 0, 0]
  let tn = (bx1 - ax1) * dby - (by1 - ay1) * dbx
  let un = (bx1 - ax1) * day - (by1 - ay1) * dax
  if (denom < 0) {
    denom = -denom
    tn = -tn
    un = -un
  }
  if (tn <= 0 || tn >= denom || un <= 0 || un >= denom) return [0, 0, 0]
  // Distance from each segment end to the crossing, compared against the
  // clearance without dividing: t * |A| < c  <=>  tn * |A| < c * denom.
  // |A| is exact for an axis-aligned segment; a diagonal one rounds its
  // hypot, which is the one remaining float in this function.
  const lenA = axisLength(dax, day)
  const lenB = axisLength(dbx, dby)
  const illegible =
    tn * lenA < CLEARANCE_Q * denom ||
    (denom - tn) * lenA < CLEARANCE_Q * denom ||
    un * lenB < CLEARANCE_Q * denom ||
    (denom - un) * lenB < CLEARANCE_Q * denom
      ? 1
      : 0
  return [0, illegible, 1]
}

/**
 * Interior vertices two paths share, on the cost quantum: two corners that
 * land on one point draw a plus sign, which a reader takes for a crossing
 * though neither segment pair crosses properly and a corner has no straight
 * run to hop along. Priced as the crossing it reads as. A path's ends are
 * left out: edges converging on one anchor share that point by design.
 */
export function sharedCorners(a: readonly Point[], b: readonly Point[]): number {
  let count = 0
  for (let i = 1; i < a.length - 1; i++) {
    const x = Math.round(a[i]!.x * COST_QUANTUM)
    const y = Math.round(a[i]!.y * COST_QUANTUM)
    let repeated = false
    for (let k = 1; k < i && !repeated; k++) {
      repeated =
        Math.round(a[k]!.x * COST_QUANTUM) === x && Math.round(a[k]!.y * COST_QUANTUM) === y
    }
    if (repeated) continue
    for (let j = 1; j < b.length - 1; j++) {
      if (Math.round(b[j]!.x * COST_QUANTUM) === x && Math.round(b[j]!.y * COST_QUANTUM) === y) {
        count++
        break
      }
    }
  }
  return count
}

/** Each pair of edges that share an interior vertex, once per shared vertex. */
function addSharedCorners(
  paths: readonly (readonly Point[])[],
  scores: Map<number, [number, number, number]>,
): void {
  const byVertex = new Map<string, number[]>()
  for (let edge = 0; edge < paths.length; edge++) {
    const path = paths[edge]!
    const own = new Set<string>()
    for (let v = 1; v < path.length - 1; v++) {
      const key = `${Math.round(path[v]!.x * COST_QUANTUM)},${Math.round(path[v]!.y * COST_QUANTUM)}`
      if (own.has(key)) continue
      own.add(key)
      const at = byVertex.get(key)
      if (at === undefined) byVertex.set(key, [edge])
      else at.push(edge)
    }
  }
  for (const edges of byVertex.values()) {
    for (let i = 0; i < edges.length; i++) {
      for (let j = i + 1; j < edges.length; j++) {
        addPairScore(scores, edges[i]! * paths.length + edges[j]!, [0, 0, 1])
      }
    }
  }
}

function axisLength(dx: number, dy: number): number {
  if (dx === 0) return Math.abs(dy)
  if (dy === 0) return Math.abs(dx)
  return Math.round(Math.hypot(dx, dy))
}

interface SweepSegment {
  readonly edge: number
  readonly a: Point
  readonly b: Point
  readonly minX: number
  readonly maxX: number
  readonly minY: number
  readonly maxY: number
}

/**
 * Every path segment as a sweep record, inflated by the broad-phase slack
 * and ordered by where it starts — which is the order the sweep consumes.
 */
function sweepSegments(paths: readonly (readonly Point[])[]): SweepSegment[] {
  const segments: SweepSegment[] = []
  for (let edge = 0; edge < paths.length; edge++) {
    const path = paths[edge]!
    for (let s = 1; s < path.length; s++) {
      const a = path[s - 1]!
      const b = path[s]!
      segments.push({
        edge,
        a,
        b,
        minX: Math.min(a.x, b.x) - BROAD_PHASE_SLACK_PX,
        maxX: Math.max(a.x, b.x) + BROAD_PHASE_SLACK_PX,
        minY: Math.min(a.y, b.y) - BROAD_PHASE_SLACK_PX,
        maxY: Math.max(a.y, b.y) + BROAD_PHASE_SLACK_PX,
      })
    }
  }
  segments.sort((s1, s2) => s1.minX - s2.minX || s1.maxX - s2.maxX || s1.edge - s2.edge)
  return segments
}

/** Drop everything from `active` that ended left of `minX`, in place. */
function evictPassed(active: SweepSegment[], minX: number): void {
  let keep = 0
  for (let i = 0; i < active.length; i++) {
    if (active[i]!.maxX >= minX) active[keep++] = active[i]!
  }
  active.length = keep
}

/** Add one pair's triple into `scores`; an all-zero triple is not recorded. */
function addPairScore(
  scores: Map<number, [number, number, number]>,
  key: number,
  [overlap, illegible, crossings]: readonly [number, number, number],
): void {
  if (overlap === 0 && illegible === 0 && crossings === 0) return
  const entry = scores.get(key)
  if (entry === undefined) scores.set(key, [overlap, illegible, crossings])
  else {
    entry[0] += overlap
    entry[1] += illegible
    entry[2] += crossings
  }
}

/**
 * Every edge pair's summed [overlap, illegible, crossings], keyed by
 * `i * paths.length + j` with `i < j` (the caller's pairKey formula).
 * Pairs whose every candidate segment pair scores zero may be absent —
 * consumers default absent keys to zero, as evaluateTrial already does.
 *
 * None of the pruning comparisons below is load-bearing on its own, which is
 * why none is pinned by a test of its own and why a reader should not add
 * one. Widening the candidate set cannot change the answer: a non-interacting
 * pair scores zero and an all-zero pair is skipped, so the extra work is the
 * only cost. Narrowing it by one slack step cannot either: two boxes that
 * meet exactly after a quarter-pixel inflation on each side were half a pixel
 * apart before it, and share no point to score. Nor can inflating one edge of
 * a box the wrong way, which translates it rather than shrinking it and so
 * preserves every genuine overlap. What the answer DOES depend
 * on is the completeness lemma above — that slack never removes a candidate —
 * and that is pinned end to end by the differential property.
 *
 * Undefined when the sweep would examine more segment pairs than
 * `budget.pairs` has left — every pair the x-sweep keeps active counts,
 * since the y-gate is itself a test. What it examined is spent either way.
 * Omitted, the build is unbounded.
 */
export function buildPairwiseScores(
  paths: readonly (readonly Point[])[],
): ReadonlyMap<number, readonly [number, number, number]>
export function buildPairwiseScores(
  paths: readonly (readonly Point[])[],
  budget: Pick<RoutingBudget, 'pairs'>,
): ReadonlyMap<number, readonly [number, number, number]> | undefined
export function buildPairwiseScores(
  paths: readonly (readonly Point[])[],
  budget?: Pick<RoutingBudget, 'pairs'>,
): ReadonlyMap<number, readonly [number, number, number]> | undefined {
  const allowance = budget?.pairs ?? Number.POSITIVE_INFINITY
  const segments = sweepSegments(paths)
  const scores = new Map<number, [number, number, number]>()
  const active: SweepSegment[] = []
  let examined = 0
  for (const segment of segments) {
    evictPassed(active, segment.minX)
    examined += active.length
    if (examined > allowance) break
    scoreAgainstActive(segment, active, paths.length, scores)
    active.push(segment)
  }
  if (budget !== undefined) budget.pairs -= examined
  if (examined > allowance) return undefined
  addSharedCorners(paths, scores)
  return scores
}

/** Score `segment` against every active segment of another edge whose y-span meets it. */
function scoreAgainstActive(
  segment: SweepSegment,
  active: readonly SweepSegment[],
  edgeCount: number,
  scores: Map<number, [number, number, number]>,
): void {
  for (const other of active) {
    if (other.edge === segment.edge) continue
    if (other.maxY < segment.minY || other.minY > segment.maxY) continue
    // Canonical argument order: the lower edge index's segment first,
    // matching the oracle's pairScore(paths[i], paths[j]) with i < j.
    const [lo, hi] = other.edge < segment.edge ? [other, segment] : [segment, other]
    const key = lo.edge * edgeCount + hi.edge
    addPairScore(scores, key, scoreSegmentPair(lo.a, lo.b, hi.a, hi.b))
  }
}
