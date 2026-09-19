/**
 * A freehand stroke, turned into the one thing the model already has for
 * ink: a LINE.
 *
 * [ADR-0038](../../../../../docs/contributing/adr/0038-ocif-projection.md)
 * decision 2 split the relation from the drawn stroke, and `canvasLineSchema`
 * says a line is "where freehand lands rather than growing a third concept".
 * This is that sentence made executable: a stroke's ends are the two points
 * the pointer was pressed and released at, and everything the hand did in
 * between is the line's `bends`.
 *
 * PRESSURE is deliberately absent for v1, and is the one thing this shape
 * cannot carry. When a stroke needs it, it arrives as a `stroke` FACET on the
 * line — a plugin's field, the way every other per-element extra is — not as
 * a new core field and not as a fourth collection. Nothing here has to change
 * for that; a facet rides beside the geometry.
 *
 * Coordinates are CANVAS space and the thresholds are SCREEN distances, which
 * is why every entry point takes the zoom: what counts as jitter, and what
 * counts as a tap rather than a stroke, is what the hand did in front of a
 * display — at zoom 0.25 the same wobble covers four times the document.
 */

import type { CanvasLine } from '@kamiazya/whiteboard-model'
import { VISUAL_EDGES_KEY, VISUAL_INK_KEY } from '@kamiazya/whiteboard-plugin-visual'
import type { Point } from './viewport.js'

/**
 * How far a sample may sit from the line between its neighbours before it is
 * a turn worth keeping, in SCREEN pixels.
 *
 * Small enough that a deliberate curve survives (a circle drawn at ordinary
 * size keeps tens of points), large enough that pointer jitter along a
 * straight run does not become geometry.
 *
 * Halved from 1.5 once the stroke started being DRAWN as a curve: the two
 * work together, and denser samples are what the rounding has to work with.
 * The floor is set by the jitter it still has to swallow — a hand wobbling
 * half a pixel along a straight run must not leave geometry behind — so this
 * is as low as it goes without the wobble becoming part of the drawing.
 */
export const STROKE_TOLERANCE_PX = 0.75

/**
 * How far the pointer must travel from where it went down, in SCREEN pixels,
 * before the gesture is ink at all. Below it the stroke is a tap, and minting
 * ink of no length gives the person something invisible they cannot click to
 * remove.
 */
export const MIN_STROKE_TRAVEL_PX = 3

/**
 * The most points one stroke may store, ends included.
 *
 * A bound rather than a hope: a pointer emits a sample per frame, so a
 * pressed-down minute is thousands of coordinates, and every one of them
 * would be written into the document's own record and merged by the CRDT
 * forever after.
 */
export const FREEHAND_MAX_POINTS = 256

/** Perpendicular distance from `p` to the segment `a`-`b`. */
function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  const t = Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

interface Span {
  readonly start: number
  readonly end: number
  /** Index of the interior sample furthest from the chord, or -1 for none. */
  readonly worstAt: number
  readonly worst: number
}

function spanOf(points: readonly Point[], start: number, end: number): Span {
  const a = points[start] as Point
  const b = points[end] as Point
  let worst = -1
  let worstAt = -1
  for (let i = start + 1; i < end; i++) {
    const distance = distanceToSegment(points[i] as Point, a, b)
    if (distance > worst) {
      worst = distance
      worstAt = i
    }
  }
  return { start, end, worstAt, worst }
}

/**
 * Ramer-Douglas-Peucker, stopped by EITHER a tolerance or a point budget.
 *
 * The two stopping rules are one algorithm rather than two passes, and that
 * is the whole design here: splitting the worst span first means the budget,
 * when it is what stops the walk, is spent on the sharpest turns the stroke
 * made. Re-running plain RDP at a coarser and coarser tolerance until it fits
 * is the obvious alternative and it DESTROYS the drawing — measured on a
 * 4000-sample sine, which came back as a single bend, because the tolerance
 * that fits 212 oscillations into 256 points is taller than the wave.
 */
export function simplifyStroke(
  points: readonly Point[],
  tolerancePx: number,
  maxPoints = Number.POSITIVE_INFINITY,
): readonly Point[] {
  if (points.length < 3) return points
  const keep = new Array<boolean>(points.length).fill(false)
  keep[0] = true
  keep[points.length - 1] = true
  let kept = 2
  const pending: Span[] = [spanOf(points, 0, points.length - 1)]
  while (pending.length > 0 && kept < maxPoints) {
    let bestAt = 0
    for (let i = 1; i < pending.length; i++) {
      if ((pending[i] as Span).worst > (pending[bestAt] as Span).worst) bestAt = i
    }
    const span = pending[bestAt] as Span
    pending.splice(bestAt, 1)
    if (span.worstAt === -1 || span.worst <= tolerancePx) continue
    keep[span.worstAt] = true
    kept++
    pending.push(spanOf(points, span.start, span.worstAt))
    pending.push(spanOf(points, span.worstAt, span.end))
  }
  return points.filter((_, i) => keep[i] === true)
}

/** How far the stroke ever got from where it went down. */
function travel(points: readonly Point[]): number {
  const first = points[0]
  if (first === undefined) return 0
  let furthest = 0
  for (const point of points) {
    furthest = Math.max(furthest, Math.hypot(point.x - first.x, point.y - first.y))
  }
  return furthest
}

/**
 * The line a stroke becomes, or `undefined` when the pointer never really
 * travelled.
 *
 * `zoom` is the viewport's, so the screen-sized thresholds above mean the
 * same thing to the hand at any magnification.
 */
export function freehandLine(
  id: string,
  points: readonly Point[],
  zoom: number,
  /**
   * The mark this stroke belongs to, when it continues one. Decided at the
   * PRESS, by the caller that holds the clock — see `stroke-group.ts`.
   */
  group?: string,
): CanvasLine | undefined {
  const scale = zoom > 0 && Number.isFinite(zoom) ? zoom : 1
  if (travel(points) < MIN_STROKE_TRAVEL_PX / scale) return undefined

  const simplified = simplifyStroke(points, STROKE_TOLERANCE_PX / scale, FREEHAND_MAX_POINTS)
  const first = simplified[0]
  const last = simplified[simplified.length - 1]
  if (first === undefined || last === undefined || simplified.length < 2) return undefined

  // A straight stroke still stores a point, and the reason is measured
  // rather than aesthetic: a point-ended line with no bends is ROUTED, and a
  // node anywhere near the run turns it into an orthogonal detour — a stroke
  // drawn from 0,0 to 400,300 past one node came back as
  // `[0,0] -> [0,56] -> [400,56] -> [400,300]`. Storing the midpoint is what
  // makes the renderer draw the path the hand drew instead of computing one
  // over it.
  const middle =
    simplified.length === 2
      ? [{ x: (first.x + last.x) / 2, y: (first.y + last.y) / 2 }]
      : simplified.slice(1, -1)

  return {
    id,
    // `end: 'none'` at both ends explicitly: the renderer's default for a
    // `to` that says nothing is an ARROW, which is right for a connector
    // somebody dragged between two things and wrong for a pen stroke.
    from: { kind: 'point', point: first, end: 'none' },
    to: { kind: 'point', point: last, end: 'none' },
    bends: middle,
    // Drawn as a curve, not as the chain of straight runs the bends
    // literally are. Every kept sample is a corner otherwise, and a stroke
    // made of corners reads as jagged however many of them there are — the
    // renderer rounds each one into the quadratic its neighbours' midpoints
    // define (`edge-rounding.ts`), which is the smoothing a drawing app
    // applies to a captured stroke.
    //
    // Stored on the line rather than decided by the renderer, because
    // `curved` is a property of THIS stroke: a line authored some other way
    // — dragged between two points with a ruler's intent — keeps its
    // corners.
    facets: {
      [VISUAL_EDGES_KEY]: { routing: 'curved' },
      // Absent for a stroke that stands alone, which is most ink: a group of
      // one is what having no group already means, and writing it would put
      // an id on every scribble for nothing.
      ...(group === undefined ? {} : { [VISUAL_INK_KEY]: { group } }),
    },
  }
}
