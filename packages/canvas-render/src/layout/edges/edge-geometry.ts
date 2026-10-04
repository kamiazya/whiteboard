/**
 * The geometry vocabulary the edge layer is written in: rectangles, points,
 * sides and polylines, with no opinion about routing or about which sides an
 * edge should use.
 *
 * It exists because that vocabulary had no home. `spatial-edges.ts` held the
 * side-choice SEARCH, the ROUTER, and these primitives in one 2100-line file,
 * and the search reached into the router's half for `rectOf`, `centerOf`,
 * `pathLength` and `tangentCoordinate` — not because it wanted to route, but
 * because that is where the words happened to live. The search and the
 * router are sibling modules now (`spatial-edges.ts`, `edge-router.ts`), and
 * this is still the one place both reach for a word.
 *
 * Nothing here knows what an obstacle is, what a lane is, or what makes one
 * route better than another. That judgement is `edge-rules.ts` (the named
 * preference and penalty rules) and `spatial-edges.ts` (the search that
 * applies them). Keeping this layer opinion-free is what lets both sides
 * share it without either one importing the other.
 */

import type { EdgeEnd, EdgeSide, LineEnd, SpatialNode } from '@kamiazya/whiteboard-model'

/** The edge layer's one point and rectangle, in canvas coordinates. */
export type Point = { readonly x: number; readonly y: number }
export type Rect = {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

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

export function sidePoint(rect: Rect, side: EdgeSide): Point {
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
export function tangentCoordinate(side: EdgeSide, point: Point): number {
  return side === 'left' || side === 'right' ? point.y : point.x
}

/** The point a fraction of the way along a side, 0 at its top/left end. */
export function sidePointAt(rect: Rect, side: EdgeSide, fraction: number): Point {
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
 * The two axes the slab test narrows against, so its one narrowing is
 * written once rather than per axis.
 *
 * A near-duplicate of `edge-rules.ts`'s `SegmentAxis`, which carries this
 * plus the along-axis half. It is not shared because that module takes its
 * `Point`/`Rect` from this one, so importing back would close a source-level
 * loop — the same misplaced-types increment `SegmentAxis`'s own comment
 * names. When the types move down here, these two become one.
 */
const SLAB_AXES = [
  { of: (p: Point) => p.x, near: (r: Rect) => r.x, far: (r: Rect) => r.x + r.w },
  { of: (p: Point) => p.y, near: (r: Rect) => r.y, far: (r: Rect) => r.y + r.h },
] as const

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
  // Slab method: the same narrowing per axis, written once and run for
  // both, with no per-call allocation — this is the innermost test of
  // candidate routing.
  let enter = 0
  let exit = 1
  for (const ax of SLAB_AXES) {
    const from = ax.of(a)
    const d = ax.of(b) - from
    const near = ax.near(rect) - from
    const far = ax.far(rect) - from
    if (d === 0) {
      // Parallel to this axis: no crossing unless it already lies within.
      // `far < 0` is unreachable while the bounding-box reject above stands
      // — for a segment parallel to this axis both endpoints share the
      // coordinate, so `min > far edge` has already returned false. Kept
      // because the pair states the condition, and dropping it would couple
      // this test to that one; measured as a surviving mutation, which is
      // what a reader of a mutation report would otherwise have to re-derive.
      if (near > 0 || far < 0) return false
      continue
    }
    const t0 = near / d
    const t1 = far / d
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
export function outwardNormal(side: EdgeSide): Point {
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

/** Axis-aligned bounds of a point set — the broad-phase box the search and
 * the router both prune with. One definition, so the two call sites do
 * not carry byte-identical copies (`boundsOf`, `boxOf`). */
export function boundingBoxOf(points: readonly Point[]): Rect {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const point of points) {
    if (point.x < minX) minX = point.x
    if (point.x > maxX) maxX = point.x
    if (point.y < minY) minY = point.y
    if (point.y > maxY) maxY = point.y
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/**
 * The box an end is anchored to — a node's, or the DEGENERATE box at a free
 * point ([ADR-0037](../../../../../docs/contributing/adr/0037-model-and-format.md)
 * slice 3b). `undefined` only for a reference to a node that is not here,
 * which is a different thing and still degrades.
 *
 * A point as a zero-size rect is what lets the router stay
 * unchanged: side choice reads centres and a degenerate box's centre IS the
 * point, `sidePoint` answers that point for all four sides, and a point
 * appears in no node list so it can never be its own obstacle or anyone
 * else's. The alternative — a second routing path for "this end has no box" —
 * would be a second producer of the geometry this package keeps to one.
 */
export function rectAtEnd(nodes: readonly SpatialNode[], end: LineEnd | EdgeEnd): Rect | undefined {
  // A LINE's end can be a bare point; an EDGE's names a node. One function for
  // both, so a caller walking either collection never has to ask which it has.
  if ('kind' in end && end.kind === 'point') return { x: end.point.x, y: end.point.y, w: 0, h: 0 }
  const node = nodes.find((n) => n.id === end.node)
  return node === undefined ? undefined : rectOf(node)
}
