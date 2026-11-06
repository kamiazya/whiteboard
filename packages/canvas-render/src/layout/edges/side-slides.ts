/**
 * Moving a route's end along its own side. A side midpoint is a default the
 * renderer chose, not authored data, so sliding an anchor is how a route buys
 * a straight run (the zero-bend lane between two facing sides, the straight
 * style's square approach) or the runway an arrowhead needs, without adding
 * a corner. The router (`edge-router.ts`) decides when; this is how far.
 */

import type { EdgeSide } from '@kamiazya/whiteboard-model'
import type { Point, Rect } from './edge-geometry.js'
import { outwardNormal, pathIsClear, tangentCoordinate } from './edge-geometry.js'
import { oppositeSide, SLIDE_CORNER_INSET_PX } from './edge-rules.js'

/**
 * The anchor slid along its side so the run to `target` is axis-aligned,
 * or undefined when the target's coordinate falls outside the side's span
 * (keeping a corner inset). A side midpoint is a default, not authored
 * data — trading it for a rectilinear route is the better-looking edge.
 */
export function slideAlongSide(
  anchor: Point,
  rect: Rect,
  side: EdgeSide,
  target: Point,
): Point | undefined {
  if (side === 'left' || side === 'right') {
    const lo = rect.y + Math.min(SLIDE_CORNER_INSET_PX, rect.h / 2)
    const hi = rect.y + rect.h - Math.min(SLIDE_CORNER_INSET_PX, rect.h / 2)
    return target.y >= lo && target.y <= hi ? { x: anchor.x, y: target.y } : undefined
  }
  const lo = rect.x + Math.min(SLIDE_CORNER_INSET_PX, rect.w / 2)
  const hi = rect.x + rect.w - Math.min(SLIDE_CORNER_INSET_PX, rect.w / 2)
  return target.x >= lo && target.x <= hi ? { x: target.x, y: anchor.y } : undefined
}

/**
 * Zero-bend shortcut: two ends on OPPOSING, mutually facing sides can often
 * share one tangent coordinate — anchors are renderer-chosen defaults, so
 * sliding one end along its side buys a single straight segment instead of
 * a stub-jog-stub elbow. Facing is required (each side's outward normal
 * points toward the other end), or an authored opposing pair with the nodes
 * swapped would draw a line backwards through both. A blocked lane answers
 * undefined and the caller falls through to the elbows.
 */
export function tryZeroBendSlide(
  start: Point,
  end: Point,
  fromSide: EdgeSide,
  toSide: EdgeSide,
  fromRect: Rect,
  toRect: Rect,
  inflated: readonly Rect[],
): Point[] | undefined {
  if (fromSide !== oppositeSide(toSide)) return undefined
  const fromNormal = outwardNormal(fromSide)
  const facing = fromNormal.x * (end.x - start.x) + fromNormal.y * (end.y - start.y) > 0
  if (!facing) return undefined
  const span = (rect: Rect, side: EdgeSide): readonly [number, number] =>
    side === 'left' || side === 'right'
      ? [
          rect.y + Math.min(SLIDE_CORNER_INSET_PX, rect.h / 2),
          rect.y + rect.h - Math.min(SLIDE_CORNER_INSET_PX, rect.h / 2),
        ]
      : [
          rect.x + Math.min(SLIDE_CORNER_INSET_PX, rect.w / 2),
          rect.x + rect.w - Math.min(SLIDE_CORNER_INSET_PX, rect.w / 2),
        ]
  const withTangent = (anchor: Point, side: EdgeSide, t: number): Point =>
    side === 'left' || side === 'right' ? { x: anchor.x, y: t } : { x: t, y: anchor.y }
  const [fromLo, fromHi] = span(fromRect, fromSide)
  const [toLo, toHi] = span(toRect, toSide)
  const lo = Math.max(fromLo, toLo)
  const hi = Math.min(fromHi, toHi)
  if (lo > hi) return undefined
  const startT = tangentCoordinate(fromSide, start)
  const endT = tangentCoordinate(toSide, end)
  // Keep an existing anchor when one already lies in the shared lane
  // (departure first, then the arrival's fan position), else move as
  // little as possible.
  const t =
    startT >= lo && startT <= hi
      ? startT
      : endT >= lo && endT <= hi
        ? endT
        : Math.min(hi, Math.max(lo, startT))
  const alignedStart = withTangent(start, fromSide, t)
  const alignedEnd = withTangent(end, toSide, t)
  if (!pathIsClear([alignedStart, alignedEnd], inflated)) return undefined
  return [alignedStart, alignedEnd]
}
/**
 * An arrowhead is ARROW_LENGTH long and is drawn ON the final segment, so an
 * approach shorter than this leaves the arrow with no line behind it — it
 * reads as a marker stuck to the box rather than an edge arriving at it. Two
 * arrow-lengths gives the head its own run plus the same again of plain line.
 */
const MIN_APPROACH_PX = 20

/**
 * The departure anchor slid along its OWN side so a perpendicular pair has
 * runway to arrive on.
 *
 * A perpendicular pair takes its corner from the departure anchor's tangent
 * coordinate, so the approach is only as long as that anchor is far from the
 * arrival side. Sliding lengthens it without adding a corner; a side with no
 * room to slide keeps the anchor and falls through to the stub-and-elbow
 * path.
 */
export function slidForApproach(
  start: Point,
  end: Point,
  fromSide: EdgeSide,
  toSide: EdgeSide,
  fromRect: Rect,
  toNormal: Point,
): Point {
  if (fromSide === toSide || fromSide === oppositeSide(toSide)) return start
  const approach = toNormal.x * (start.x - end.x) + toNormal.y * (start.y - end.y)
  if (approach <= 0 || approach >= MIN_APPROACH_PX) return start
  const shortfall = MIN_APPROACH_PX - approach
  return (
    slideAlongSide(start, fromRect, fromSide, {
      x: start.x + toNormal.x * shortfall,
      y: start.y + toNormal.y * shortfall,
    }) ?? start
  )
}

/**
 * A same-side pair's shared corridor, deepened just enough to clear the
 * arrival anchor by a full approach.
 *
 * The approach is measured from the DEPARTURE anchor, so an arrival box that
 * reaches further out than the departure box eats into it, and one that
 * reaches further than the stub is deep leaves the corridor arriving from
 * inside. Deepening is the same-side analogue of the departure slide: it
 * buys the runway without adding a bend, because the corridor is a segment
 * the route already draws.
 *
 * Only the band where the corridor clears the arrival anchor but by less
 * than an approach. Deeper than that (`approach <= 0`) the corridor arrives
 * from inside, the arrival stub is kept, and that stub IS the runway —
 * deepening those turns a sound route into a long detour around the outside
 * of a box that reaches far further out than its partner. Inside the band
 * the correction is bounded by MIN_APPROACH_PX, so the corridor never moves
 * more than one approach.
 */
export function deepenedCorridor(
  start: Point,
  end: Point,
  fromSide: EdgeSide,
  toSide: EdgeSide,
  fromDepth: number,
  toNormal: Point,
): number {
  if (fromSide !== toSide) return fromDepth
  const arrivalOvershoot = toNormal.x * (end.x - start.x) + toNormal.y * (end.y - start.y)
  const approach = fromDepth - arrivalOvershoot
  if (approach <= 0 || approach >= MIN_APPROACH_PX) return fromDepth
  return arrivalOvershoot + MIN_APPROACH_PX
}
