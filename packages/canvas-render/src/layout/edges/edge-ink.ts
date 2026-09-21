/**
 * How an edge's INK is measured, separately from what the rules charge for
 * it.
 *
 * Each term here answers one question about a routed path's geometry — how
 * much of it lies along a set of rects, through a bystander's body, or over
 * itself — in the `COST_QUANTUM`-quantized integer space every ink-length
 * term is measured in, so a term is integral by construction. Which of them
 * a named rule reads, and at what tier, is `edge-rules.ts`'s business and
 * not this module's.
 *
 * The cost SPACE lives here too — `COST_QUANTUM` and `quantize` — because it
 * is what these measurements are taken in, and because putting it the other
 * way round would close a VALUE cycle between the two modules (arch-lint's
 * `repo-coverage` catches that one, and did). `edge-rules.ts` re-exports the
 * quantum, so no caller changed.
 *
 * `Point` and `Rect` still come FROM that module, which is the wrong
 * direction for a vocabulary and the same misplacement `edge-geometry.ts`
 * records: the types belong one layer down, and moving them is its own
 * increment. That import is TYPE-ONLY, so it closes nothing.
 */
import type { Point, Rect } from './edge-rules.js'

/** Quarter-pixel quantization: every PENALTY_RULES term is integral, so
 * candidate comparison is exact integer arithmetic — no float tie can
 * differ between platforms (see edge-crossing-sweep.ts's matching
 * COST_QUANTUM, which the narrow phase quantizes with independently). */
export const COST_QUANTUM = 4

/**
 * The one COST_QUANTUM rounding every ink term measures in. Sub-quantum
 * differences are rounding wobble, not geometry: anchors land on fractions
 * (a slid anchor can sit at 233.333...px), so terms that compare or subtract
 * coordinates must agree on where the grid is.
 */
export function quantize(n: number): number {
  return Math.round(n * COST_QUANTUM)
}

/**
 * An axis-aligned SEGMENT's orientation, with everything that follows from
 * it: which coordinate varies along the segment, which one fixes the line it
 * sits on, and a rect's two borders on each.
 *
 * Every ink term below is one measurement stated once and run for both
 * orientations, and each used to re-derive all six from a `horizontal`
 * boolean at the point of use — inside loops that are quadratic in the
 * segment count, so the same six were recomputed per comparison.
 */
interface SegmentAxis {
  /** The coordinate that VARIES along the segment. */
  readonly along: (p: Point) => number
  /** The coordinate that stays FIXED — the line the segment sits on. */
  readonly across: (p: Point) => number
  /** A rect's near edge along the varying axis. */
  readonly nearAlong: (r: Rect) => number
  /** Its far edge along that axis. */
  readonly farAlong: (r: Rect) => number
  /** Its near edge ACROSS — one of the two borders a fixed coordinate is judged against. */
  readonly nearAcross: (r: Rect) => number
  /** And its far one. */
  readonly farAcross: (r: Rect) => number
}

const HORIZONTAL_SEGMENT: SegmentAxis = {
  along: (p) => p.x,
  across: (p) => p.y,
  nearAlong: (r) => r.x,
  farAlong: (r) => r.x + r.w,
  nearAcross: (r) => r.y,
  farAcross: (r) => r.y + r.h,
}

const VERTICAL_SEGMENT: SegmentAxis = {
  along: (p) => p.y,
  across: (p) => p.x,
  nearAlong: (r) => r.y,
  farAlong: (r) => r.y + r.h,
  nearAcross: (r) => r.x,
  farAcross: (r) => r.x + r.w,
}

/**
 * The orientation of `a`->`b`, or undefined when it is diagonal or DEGENERATE.
 *
 * A zero-length segment answers undefined rather than picking an orientation
 * arbitrarily: it has no line to sit on, and every ink term measures an
 * OVERLAP, which is empty for it under either reading. So the terms that used
 * to treat it as horizontal and the ones that skipped it outright were already
 * computing the same number, and now say so.
 */
function segmentAxis(a: Point, b: Point): SegmentAxis | undefined {
  if (a.y === b.y && a.x !== b.x) return HORIZONTAL_SEGMENT
  if (a.x === b.x && a.y !== b.y) return VERTICAL_SEGMENT
  return undefined
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
export function inkAlongRects(
  path: readonly Point[],
  rects: readonly Rect[],
  qualifies: (fixed: number, near: number, far: number) => boolean,
): number {
  const q = quantize
  let total = 0
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] as Point
    const b = path[i] as Point
    const ax = segmentAxis(a, b)
    if (ax === undefined) continue
    const fixed = q(ax.across(a))
    const p1 = ax.along(a)
    const p2 = ax.along(b)
    for (const r of rects) {
      if (!qualifies(fixed, q(ax.nearAcross(r)), q(ax.farAcross(r)))) continue
      const lo = Math.max(q(Math.min(p1, p2)), q(ax.nearAlong(r)))
      const hi = Math.min(q(Math.max(p1, p2)), q(ax.farAlong(r)))
      if (hi > lo) total += hi - lo
    }
  }
  return total
}

/**
 * Ink from an axis-aligned segment running through a bystander node's raw
 * body — a line through a node reads as though it connects that node, which
 * no line jump can express.
 *
 * Only through a body whose OTHER axis STRICTLY contains the segment — the
 * same reject the router and the grid search already apply. Boundary grazing
 * stays excluded: an anchor ON a neighbour's border, or a segment riding the
 * margin band, is `bestCandidate`'s business and not a tunnel.
 */
export function tunnelledInk(path: readonly Point[], foreignBodies: readonly Rect[]): number {
  let ink = 0
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] as Point
    const b = path[i] as Point
    const ax = segmentAxis(a, b)
    if (ax === undefined) continue
    const fixed = ax.across(a)
    const p1 = ax.along(a)
    const p2 = ax.along(b)
    for (const r of foreignBodies) {
      if (fixed <= ax.nearAcross(r) || fixed >= ax.farAcross(r)) continue
      const lo = Math.max(Math.min(p1, p2), ax.nearAlong(r))
      const hi = Math.min(Math.max(p1, p2), ax.farAlong(r))
      if (hi > lo) ink += quantize(hi - lo)
    }
  }
  return ink
}

/**
 * Ink the path lays over itself: the doubled-line arrival a facing-away side
 * produces when the connector overshoots the entry stub through the node
 * body. Collinear overlap only — a parallel overlap has no crossing point,
 * so a line jump cannot express it.
 *
 * Quantized once per POINT rather than per comparison: this is quadratic in
 * the segment count and re-derived the same six values for every pair.
 * `quantize` is pure, so the sums are unchanged.
 */
export function selfRetracedInk(path: readonly Point[]): number {
  const qx = path.map((p) => quantize(p.x))
  const qy = path.map((p) => quantize(p.y))
  let ink = 0
  for (let i = 1; i < path.length; i++) {
    for (let j = i + 1; j < path.length; j++) {
      ink += collinearOverlap(qx, qy, i, j) + collinearOverlap(qy, qx, i, j)
    }
  }
  return ink
}

/**
 * How far segments `i` and `j` overlap while sharing a line — `fixed` being
 * the coordinate that must agree across all four points and `varying` the
 * one the overlap is measured in. Called once per orientation, so a segment
 * pair that is not collinear on either answers zero twice.
 */
function collinearOverlap(
  fixed: readonly number[],
  varying: readonly number[],
  i: number,
  j: number,
): number {
  const a = fixed[i - 1] as number
  const b = fixed[j - 1] as number
  if (a !== (fixed[i] as number) || b !== (fixed[j] as number) || a !== b) return 0
  const lo = Math.max(
    Math.min(varying[i - 1] as number, varying[i] as number),
    Math.min(varying[j - 1] as number, varying[j] as number),
  )
  const hi = Math.min(
    Math.max(varying[i - 1] as number, varying[i] as number),
    Math.max(varying[j - 1] as number, varying[j] as number),
  )
  return hi > lo ? hi - lo : 0
}
