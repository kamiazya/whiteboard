/**
 * Where two boxes that TOUCH — a shared border, or bodies that overlap —
 * meet. Such a pair has no distance between it to route: every route the
 * router can build leaves one box and comes back round to the other, which
 * reads as a loop rather than a connection. What is drawn instead is the
 * contact itself, one arrowhead long, ending on the target's facing side and
 * centred on the stretch the two facing sides share.
 *
 * A positive gap, however small, is not contact and is routed as usual.
 */

import type { EdgeSide, SpatialNode } from '@kamiazya/whiteboard-model'
import { endSide } from '@kamiazya/whiteboard-model'
import type { ResolvedEdgeNode, RoutableElement } from '@kamiazya/whiteboard-scene'
import { type Point, type Rect, rectAtEnd } from './edge-geometry.js'

/** How long the contact mark runs, in px: one arrowhead (`edge-arrows.ts`). */
const CONTACT_MARK_PX = 10

/** Below this the mark has no direction to draw an arrowhead along. */
const MIN_CONTACT_MARK_PX = 1

interface Contact {
  readonly path: readonly [Point, Point]
  readonly fromSide: EdgeSide
  readonly toSide: EdgeSide
}

interface AxisSpan {
  readonly near: number
  readonly far: number
}

const spanX = (r: Rect): AxisSpan => ({ near: r.x, far: r.x + r.w })
const spanY = (r: Rect): AxisSpan => ({ near: r.y, far: r.y + r.h })

/** How far two spans overlap; zero when they only meet, negative when apart. */
const overlap = (a: AxisSpan, b: AxisSpan) => Math.min(a.far, b.far) - Math.max(a.near, b.near)

const holds = (outer: Rect, inner: Rect) =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.w <= outer.x + outer.w &&
  inner.y + inner.h <= outer.y + outer.h

/**
 * The contact between `from` and `to`, or `undefined` when the two are
 * apart, meet only at a corner, or one holds the other (a frame and its
 * member are routed, never marked).
 *
 * Contact runs along the axis the boxes penetrate LEAST, relative to their
 * summed extent on it — the axis they would be pulled apart along — so a
 * pair overlapping by most of their width but a sliver of their height
 * meets on the horizontal border. When that axis leaves no room for a mark
 * (the target spans the source along it), the other axis is asked.
 */
function contactBetween(from: Rect, to: Rect): Contact | undefined {
  const ox = overlap(spanX(from), spanX(to))
  const oy = overlap(spanY(from), spanY(to))
  if (ox < 0 || oy < 0) return undefined
  if (holds(from, to) || holds(to, from)) return undefined
  const xFirst = ox / (from.w + to.w) <= oy / (from.h + to.h)
  const order = xFirst ? ([true, false] as const) : ([false, true] as const)
  for (const alongX of order) {
    const contact = contactAlong(from, to, alongX)
    if (contact !== undefined) return contact
  }
  return undefined
}

function contactAlong(from: Rect, to: Rect, alongX: boolean): Contact | undefined {
  const [fromSpan, toSpan, fromCross, toCross] = alongX
    ? [spanX(from), spanX(to), spanY(from), spanY(to)]
    : [spanY(from), spanY(to), spanX(from), spanX(to)]
  if (overlap(fromCross, toCross) <= 0) return undefined
  const fromCentre = (fromSpan.near + fromSpan.far) / 2
  const toCentre = (toSpan.near + toSpan.far) / 2
  if (fromCentre === toCentre) return undefined
  const forward = toCentre > fromCentre

  const tipAlong = forward ? toSpan.near : toSpan.far
  // The mark runs back into the source, and stops at its far side.
  const room = forward ? tipAlong - fromSpan.near : fromSpan.far - tipAlong
  const length = Math.min(CONTACT_MARK_PX, room)
  if (length < MIN_CONTACT_MARK_PX) return undefined
  const tailAlong = forward ? tipAlong - length : tipAlong + length
  const crossMid =
    (Math.max(fromCross.near, toCross.near) + Math.min(fromCross.far, toCross.far)) / 2

  const at = (along: number): Point =>
    alongX ? { x: along, y: crossMid } : { x: crossMid, y: along }
  const [fromSide, toSide]: [EdgeSide, EdgeSide] = alongX
    ? forward
      ? ['right', 'left']
      : ['left', 'right']
    : forward
      ? ['bottom', 'top']
      : ['top', 'bottom']
  return { path: [at(tailAlong), at(tipAlong)], fromSide, toSide }
}

/**
 * The contact an edge is drawn as, or `undefined` when it is routed. A side
 * the author NAMED that the contact does not use keeps the computed route,
 * since the author asked for that face.
 */
function contactFor(edge: RoutableElement, fromRect: Rect, toRect: Rect): Contact | undefined {
  const contact = contactBetween(fromRect, toRect)
  if (contact === undefined) return undefined
  const namedFrom = endSide(edge.from)
  const namedTo = endSide(edge.to)
  if (namedFrom !== undefined && namedFrom !== contact.fromSide) return undefined
  if (namedTo !== undefined && namedTo !== contact.toSide) return undefined
  return contact
}

/**
 * Whether `routeEdge` will draw this edge as a contact mark — asked by the
 * side-choice search, which leaves such an edge out: the mark takes no
 * slot on a side, and there is nothing about it for the search to improve.
 * Stored bends are drawn ahead of a contact, so an edge carrying them is
 * routed.
 */
export function marksContact(nodes: readonly SpatialNode[], edge: RoutableElement): boolean {
  if ((edge.bends?.length ?? 0) > 0) return false
  const fromRect = rectAtEnd(nodes, edge.from)
  const toRect = rectAtEnd(nodes, edge.to)
  if (fromRect === undefined || toRect === undefined) return false
  return contactFor(edge, fromRect, toRect) !== undefined
}

/**
 * Two boxes that touch are marked where they meet rather than routed, in
 * every style: there is no distance for a style to shape.
 */
export function contactRoute(
  edge: RoutableElement,
  fromRect: Rect,
  toRect: Rect,
  fromEnd: 'none' | 'arrow',
  toEnd: 'none' | 'arrow',
): ResolvedEdgeNode | undefined {
  const contact = contactFor(edge, fromRect, toRect)
  if (contact === undefined) return undefined
  return {
    kind: 'edge',
    id: edge.id,
    path: [...contact.path],
    fromSide: contact.fromSide,
    toSide: contact.toSide,
    fromEnd,
    toEnd,
  }
}
