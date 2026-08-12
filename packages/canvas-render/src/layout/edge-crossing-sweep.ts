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
import { EDGE_JUMP_RADIUS_PX } from './edge-jumps.js'

type Point = { readonly x: number; readonly y: number }

/** Matches spatial-edges' COST_QUANTUM discipline (quarter-pixel integers). */
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
  const clearance = EDGE_JUMP_RADIUS_PX + 1
  // Collinear axis-aligned overlap.
  if (q(a1.y) === q(a2.y) && q(b1.y) === q(b2.y) && q(a1.y) === q(b1.y)) {
    const lo = Math.max(q(Math.min(a1.x, a2.x)), q(Math.min(b1.x, b2.x)))
    const hi = Math.min(q(Math.max(a1.x, a2.x)), q(Math.max(b1.x, b2.x)))
    return [hi > lo ? hi - lo : 0, 0, 0]
  }
  if (q(a1.x) === q(a2.x) && q(b1.x) === q(b2.x) && q(a1.x) === q(b1.x)) {
    const lo = Math.max(q(Math.min(a1.y, a2.y)), q(Math.min(b1.y, b2.y)))
    const hi = Math.min(q(Math.max(a1.y, a2.y)), q(Math.max(b1.y, b2.y)))
    return [hi > lo ? hi - lo : 0, 0, 0]
  }
  // Proper transversal crossing.
  const dax = a2.x - a1.x
  const day = a2.y - a1.y
  const dbx = b2.x - b1.x
  const dby = b2.y - b1.y
  const denom = dax * dby - day * dbx
  if (denom === 0) return [0, 0, 0]
  const t = ((b1.x - a1.x) * dby - (b1.y - a1.y) * dbx) / denom
  const u = ((b1.x - a1.x) * day - (b1.y - a1.y) * dax) / denom
  if (t <= 0 || t >= 1 || u <= 0 || u >= 1) return [0, 0, 0]
  const lenA = Math.hypot(dax, day)
  const lenB = Math.hypot(dbx, dby)
  const illegible =
    t * lenA < clearance ||
    (1 - t) * lenA < clearance ||
    u * lenB < clearance ||
    (1 - u) * lenB < clearance
      ? 1
      : 0
  return [0, illegible, 1]
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
 * Every edge pair's summed [overlap, illegible, crossings], keyed by
 * `i * paths.length + j` with `i < j` (the caller's pairKey formula).
 * Pairs whose every candidate segment pair scores zero may be absent —
 * consumers default absent keys to zero, as evaluateTrial already does.
 */
export function buildPairwiseScores(
  paths: readonly (readonly Point[])[],
): ReadonlyMap<number, readonly [number, number, number]> {
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

  const scores = new Map<number, [number, number, number]>()
  const active: SweepSegment[] = []
  for (const segment of segments) {
    // Evict everything that ended left of this segment's start.
    let keep = 0
    for (let i = 0; i < active.length; i++) {
      if (active[i]!.maxX >= segment.minX) active[keep++] = active[i]!
    }
    active.length = keep
    for (const other of active) {
      if (other.edge === segment.edge) continue
      if (other.maxY < segment.minY || other.minY > segment.maxY) continue
      // Canonical argument order: the lower edge index's segment first,
      // matching the oracle's pairScore(paths[i], paths[j]) with i < j.
      const [lo, hi] = other.edge < segment.edge ? [other, segment] : [segment, other]
      const [overlap, illegible, crossings] = scoreSegmentPair(lo.a, lo.b, hi.a, hi.b)
      if (overlap === 0 && illegible === 0 && crossings === 0) continue
      const key = lo.edge * paths.length + hi.edge
      const entry = scores.get(key)
      if (entry === undefined) scores.set(key, [overlap, illegible, crossings])
      else {
        entry[0] += overlap
        entry[1] += illegible
        entry[2] += crossings
      }
    }
    active.push(segment)
  }
  return scores
}
