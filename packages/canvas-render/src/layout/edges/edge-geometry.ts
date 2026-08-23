/**
 * The geometry vocabulary the edge layer is written in: rectangles, points,
 * sides and polylines, with no opinion about routing or about which sides an
 * edge should use.
 *
 * It exists because that vocabulary had no home. `spatial-edges.ts` held the
 * side-choice SEARCH, the ROUTER, and these primitives in one 2100-line file,
 * and the search reached into the router's half for `rectOf`, `centerOf`,
 * `pathLength` and `tangentCoordinate` — not because it wanted to route, but
 * because that is where the words happened to live.
 *
 * Nothing here knows what an obstacle is, what a lane is, or what makes one
 * route better than another. That judgement is `edge-rules.ts` (the named
 * preference and penalty rules) and `spatial-edges.ts` (the search that
 * applies them). Keeping this layer opinion-free is what lets both sides
 * share it without either one importing the other.
 */

import type { SpatialNode } from '@kamiazya/whiteboard-model'
import type { Point, Rect, Side } from './edge-rules.js'

export function rectOf(node: SpatialNode): Rect {
  return { x: node.x, y: node.y, w: node.width, h: node.height }
}

export function centerOf(rect: Rect): Point {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }
}

/** Border-inclusive: a point sitting exactly on the rect's edge counts as inside. */
export function containsPoint(rect: Rect, point: Point): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.w &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.h
  )
}

export function sidePoint(rect: Rect, side: Side): Point {
  switch (side) {
    case 'top':
      return { x: rect.x + rect.w / 2, y: rect.y }
    case 'bottom':
      return { x: rect.x + rect.w / 2, y: rect.y + rect.h }
    case 'left':
      return { x: rect.x, y: rect.y + rect.h / 2 }
    case 'right':
      return { x: rect.x + rect.w, y: rect.y + rect.h / 2 }
  }
}

/** Strict interior: a point exactly on the border is NOT inside, so a node
 * merely touching another (tidy adjacent layouts) never reads as occluding. */
export function strictlyInside(rect: Rect, point: Point): boolean {
  return (
    point.x > rect.x && point.x < rect.x + rect.w && point.y > rect.y && point.y < rect.y + rect.h
  )
}

/** The coordinate that orders ends along a side: y on vertical sides, x on horizontal. */
export function tangentCoordinate(side: Side, point: Point): number {
  return side === 'left' || side === 'right' ? point.y : point.x
}

/** The point a fraction of the way along a side, 0 at its top/left end. */
export function sidePointAt(rect: Rect, side: Side, fraction: number): Point {
  switch (side) {
    case 'top':
      return { x: rect.x + rect.w * fraction, y: rect.y }
    case 'bottom':
      return { x: rect.x + rect.w * fraction, y: rect.y + rect.h }
    case 'left':
      return { x: rect.x, y: rect.y + rect.h * fraction }
    case 'right':
      return { x: rect.x + rect.w, y: rect.y + rect.h * fraction }
  }
}

/**
 * Whether a segment passes through a rect's INTERIOR. Touching a border does
 * not count: every edge starts and ends on a border by construction, and a
 * route that grazes a corner is not the failure this is looking for.
 *
 * Slab method, with the parallel-to-an-axis case handled by the same
 * comparison rather than a special branch.
 */
export function segmentCrossesRect(a: Point, b: Point, rect: Rect): boolean {
  const right = rect.x + rect.w
  const bottom = rect.y + rect.h
  // Bounding-box reject first: this is the innermost test of candidate
  // routing, called once per segment per obstacle, and almost every pair
  // is nowhere near each other.
  if (
    Math.max(a.x, b.x) < rect.x ||
    Math.min(a.x, b.x) > right ||
    Math.max(a.y, b.y) < rect.y ||
    Math.min(a.y, b.y) > bottom
  ) {
    return false
  }
  const dx = b.x - a.x
  const dy = b.y - a.y
  let enter = 0
  let exit = 1
  // Slab method, one axis at a time, no per-call allocation.
  if (dx === 0) {
    // Parallel to this axis: no crossing unless it already lies within.
    if (rect.x - a.x > 0 || right - a.x < 0) return false
  } else {
    const t0 = (rect.x - a.x) / dx
    const t1 = (right - a.x) / dx
    enter = Math.max(enter, Math.min(t0, t1))
    exit = Math.min(exit, Math.max(t0, t1))
    if (enter >= exit) return false
  }
  if (dy === 0) {
    if (rect.y - a.y > 0 || bottom - a.y < 0) return false
  } else {
    const t0 = (rect.y - a.y) / dy
    const t1 = (bottom - a.y) / dy
    enter = Math.max(enter, Math.min(t0, t1))
    exit = Math.min(exit, Math.max(t0, t1))
    if (enter >= exit) return false
  }
  return exit > enter
}

export const pathIsClear = (path: readonly Point[], obstacles: readonly Rect[]) =>
  path.every(
    (point, i) =>
      i === 0 || obstacles.every((rect) => !segmentCrossesRect(path[i - 1] as Point, point, rect)),
  )

export function unionRect(rects: readonly Rect[]): Rect | undefined {
  const [first, ...rest] = rects
  if (first === undefined) return undefined
  let minX = first.x
  let minY = first.y
  let maxX = first.x + first.w
  let maxY = first.y + first.h
  for (const rect of rest) {
    minX = Math.min(minX, rect.x)
    minY = Math.min(minY, rect.y)
    maxX = Math.max(maxX, rect.x + rect.w)
    maxY = Math.max(maxY, rect.y + rect.h)
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

export const pathLength = (path: readonly Point[]) =>
  path.reduce(
    (total, point, i) =>
      i === 0
        ? 0
        : total +
          Math.hypot(point.x - (path[i - 1] as Point).x, point.y - (path[i - 1] as Point).y),
    0,
  )

/** The direction a side faces, away from the node's interior. */
export function outwardNormal(side: Side): Point {
  switch (side) {
    case 'top':
      return { x: 0, y: -1 }
    case 'bottom':
      return { x: 0, y: 1 }
    case 'left':
      return { x: -1, y: 0 }
    case 'right':
      return { x: 1, y: 0 }
  }
}

/** Drops repeated points, so a collapsed corner never becomes a zero-length segment. */
export function withoutRepeats(path: readonly Point[]): Point[] {
  return path.filter((point, i) => {
    const prev = path[i - 1]
    return i === 0 || prev === undefined || point.x !== prev.x || point.y !== prev.y
  })
}
