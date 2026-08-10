import type { CanvasEdge, EdgeRoutingStyle, SpatialNode } from '@kamiazya/whiteboard-canvas-model'
import type { ResolvedEdgeNode } from '../scene-graph.js'

type Side = 'top' | 'right' | 'bottom' | 'left'
type Point = { readonly x: number; readonly y: number }
type Rect = { readonly x: number; readonly y: number; readonly w: number; readonly h: number }

function rectOf(node: SpatialNode): Rect {
  return { x: node.x, y: node.y, w: node.width, h: node.height }
}

function centerOf(rect: Rect): Point {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }
}

function sidePoint(rect: Rect, side: Side): Point {
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

/**
 * Deterministic default-side derivation for an edge with no explicit
 * fromSide/toSide: pick the axis with the larger center-to-center offset,
 * then the side facing the other node along that axis. Ties (equal
 * horizontal/vertical offset) prefer the horizontal axis — a fixed,
 * arbitrary-but-stable tie-breaker.
 */
function deriveDefaultSides(fromRect: Rect, toRect: Rect): { fromSide: Side; toSide: Side } {
  const fromCenter = centerOf(fromRect)
  const toCenter = centerOf(toRect)
  const dx = toCenter.x - fromCenter.x
  const dy = toCenter.y - fromCenter.y

  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? { fromSide: 'right', toSide: 'left' } : { fromSide: 'left', toSide: 'right' }
  }
  return dy >= 0 ? { fromSide: 'bottom', toSide: 'top' } : { fromSide: 'top', toSide: 'bottom' }
}

/** Distance the self-edge loop bulges out along the selected side's outward normal, in px. */
const SELF_EDGE_LOOP_OFFSET_PX = 40
/** Half-width of the self-edge loop along the side perpendicular to the outward normal, in px. */
const SELF_EDGE_LOOP_SPREAD_PX = 20

/**
 * Two control points for a self-edge loop, offset outward from `start` along
 * `side`'s outward normal (not toward the node interior) and spread along the
 * perpendicular axis so the loop reads as a visible bulge rather than a
 * straight line back to itself.
 */
function selfEdgeLoopControlPoints(start: Point, side: Side): [Point, Point] {
  switch (side) {
    case 'right':
      return [
        { x: start.x + SELF_EDGE_LOOP_OFFSET_PX, y: start.y - SELF_EDGE_LOOP_SPREAD_PX },
        { x: start.x + SELF_EDGE_LOOP_OFFSET_PX, y: start.y + SELF_EDGE_LOOP_SPREAD_PX },
      ]
    case 'left':
      return [
        { x: start.x - SELF_EDGE_LOOP_OFFSET_PX, y: start.y - SELF_EDGE_LOOP_SPREAD_PX },
        { x: start.x - SELF_EDGE_LOOP_OFFSET_PX, y: start.y + SELF_EDGE_LOOP_SPREAD_PX },
      ]
    case 'top':
      return [
        { x: start.x - SELF_EDGE_LOOP_SPREAD_PX, y: start.y - SELF_EDGE_LOOP_OFFSET_PX },
        { x: start.x + SELF_EDGE_LOOP_SPREAD_PX, y: start.y - SELF_EDGE_LOOP_OFFSET_PX },
      ]
    case 'bottom':
      return [
        { x: start.x - SELF_EDGE_LOOP_SPREAD_PX, y: start.y + SELF_EDGE_LOOP_OFFSET_PX },
        { x: start.x + SELF_EDGE_LOOP_SPREAD_PX, y: start.y + SELF_EDGE_LOOP_OFFSET_PX },
      ]
  }
}

/** How far a detour keeps clear of the boxes it steps around, in px. */
const OBSTACLE_CLEARANCE_PX = 16

/**
 * Whether a segment passes through a rect's INTERIOR. Touching a border does
 * not count: every edge starts and ends on a border by construction, and a
 * route that grazes a corner is not the failure this is looking for.
 *
 * Slab method, with the parallel-to-an-axis case handled by the same
 * comparison rather than a special branch.
 */
function segmentCrossesRect(a: Point, b: Point, rect: Rect): boolean {
  const dx = b.x - a.x
  const dy = b.y - a.y
  let enter = 0
  let exit = 1
  const slabs: readonly [number, number, number][] = [
    [dx, rect.x - a.x, rect.x + rect.w - a.x],
    [dy, rect.y - a.y, rect.y + rect.h - a.y],
  ]
  for (const [delta, near, far] of slabs) {
    if (delta === 0) {
      // Parallel to this axis: no crossing unless it already lies within.
      if (near > 0 || far < 0) return false
      continue
    }
    const t0 = Math.min(near / delta, far / delta)
    const t1 = Math.max(near / delta, far / delta)
    enter = Math.max(enter, t0)
    exit = Math.min(exit, t1)
    if (enter >= exit) return false
  }
  return exit > enter
}

const pathIsClear = (path: readonly Point[], obstacles: readonly Rect[]) =>
  path.every(
    (point, i) =>
      i === 0 || obstacles.every((rect) => !segmentCrossesRect(path[i - 1] as Point, point, rect)),
  )

function unionRect(rects: readonly Rect[]): Rect | undefined {
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

const pathLength = (path: readonly Point[]) =>
  path.reduce(
    (total, point, i) =>
      i === 0
        ? 0
        : total +
          Math.hypot(point.x - (path[i - 1] as Point).x, point.y - (path[i - 1] as Point).y),
    0,
  )

/**
 * A path from `start` to `end` that steps around everything in `obstacles`.
 *
 * Four candidates — over, under, left of, right of the blocking region — each
 * a pair of waypoints on one side of it. The shortest candidate that is
 * itself clear wins; if none is clear the shortest is used anyway, because
 * layout has to return SOMETHING and a route that still crosses is better
 * than a thrown error or a straight line through everything.
 *
 * Deliberately not a visibility graph or A*: this runs per edge on every
 * layout, and four candidates against a union box handles the arrangements
 * that actually occur (a node or two sitting between two others). A denser
 * search belongs behind the routing-style setting, not in the default path.
 */
/** The candidate that clears every obstacle, shortest first; the shortest overall if none does. */
function bestCandidate(candidates: readonly Point[][], obstacles: readonly Rect[]): Point[] {
  const byLength = [...candidates].sort((a, b) => pathLength(a) - pathLength(b))
  return byLength.find((path) => pathIsClear(path, obstacles)) ?? (byLength[0] as Point[])
}

/** Ways past a blocking region: over it, under it, left of it, right of it. */
function detourCandidates(start: Point, end: Point, region: Rect): Point[][] {
  const above = region.y - OBSTACLE_CLEARANCE_PX
  const below = region.y + region.h + OBSTACLE_CLEARANCE_PX
  const leftOf = region.x - OBSTACLE_CLEARANCE_PX
  const rightOf = region.x + region.w + OBSTACLE_CLEARANCE_PX
  return [
    [start, { x: start.x, y: above }, { x: end.x, y: above }, end],
    [start, { x: start.x, y: below }, { x: end.x, y: below }, end],
    [start, { x: leftOf, y: start.y }, { x: leftOf, y: end.y }, end],
    [start, { x: rightOf, y: start.y }, { x: rightOf, y: end.y }, end],
  ]
}

/** The union of whatever `start`→`end` runs through, if anything does. */
function blockingRegion(start: Point, end: Point, obstacles: readonly Rect[]): Rect | undefined {
  return unionRect(obstacles.filter((rect) => segmentCrossesRect(start, end, rect)))
}

function routeStraight(start: Point, end: Point, obstacles: readonly Rect[]): Point[] {
  const region = blockingRegion(start, end, obstacles)
  if (region === undefined) return [start, end]
  return bestCandidate(detourCandidates(start, end, region), obstacles)
}

/** How far an orthogonal edge travels straight out of a node before turning. */
const ORTHOGONAL_STUB_PX = 20

/** The direction a side faces, away from the node's interior. */
function outwardNormal(side: Side): Point {
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

function stubFrom(point: Point, side: Side): Point {
  const normal = outwardNormal(side)
  return {
    x: point.x + normal.x * ORTHOGONAL_STUB_PX,
    y: point.y + normal.y * ORTHOGONAL_STUB_PX,
  }
}

/** Drops repeated points, so a collapsed corner never becomes a zero-length segment. */
function withoutRepeats(path: readonly Point[]): Point[] {
  return path.filter((point, i) => {
    const prev = path[i - 1]
    return i === 0 || prev === undefined || point.x !== prev.x || point.y !== prev.y
  })
}

/**
 * Right angles only, whether or not anything is in the way — that is what the
 * style asks for, so a clear path bends too.
 *
 * Both ends leave along their side's outward normal before turning. Without
 * that stub an edge attached to a node's right side can start by running
 * vertically, tracing the node's own border for its first segment so the two
 * read as one line rather than as an edge meeting a box.
 *
 * The elbows come first and the detours join them only when something blocks,
 * which keeps the common case to a single corner instead of routing every
 * edge around a region that is not there.
 */
function routeOrthogonal(
  start: Point,
  end: Point,
  fromSide: Side,
  toSide: Side,
  obstacles: readonly Rect[],
): Point[] {
  const exit = stubFrom(start, fromSide)
  const entry = stubFrom(end, toSide)
  const between = (middles: readonly Point[]) =>
    withoutRepeats([start, exit, ...middles, entry, end])

  const region = blockingRegion(start, end, obstacles)
  const candidates = [
    between([{ x: entry.x, y: exit.y }]),
    between([{ x: exit.x, y: entry.y }]),
    ...(region === undefined
      ? []
      : detourCandidates(exit, entry, region).map((path) => between(path.slice(1, -1)))),
  ]
  return bestCandidate(candidates, obstacles)
}

/**
 * Resolves one canvas-model edge into a scene-graph edge with a concrete
 * point path. Pure function of (nodes, edge): never throws — a missing
 * endpoint id degenerates to a zero-length path at the origin rather than
 * raising, so a single bad reference never aborts layout for the rest of
 * the canvas.
 *
 * The path steps around any OTHER node between the endpoints; an edge drawn
 * straight through a node reads as though it connects that node instead. The
 * two endpoint nodes are never obstacles — the edge has to reach them.
 */
export function routeEdge(
  nodes: readonly SpatialNode[],
  edge: CanvasEdge,
  style: EdgeRoutingStyle = 'straight',
): ResolvedEdgeNode {
  const fromNode = nodes.find((n) => n.id === edge.fromNode)
  const toNode = nodes.find((n) => n.id === edge.toNode)

  // JSON Canvas 1.0 defaults: no source arrowhead, a destination arrowhead.
  const fromEnd = edge.fromEnd ?? 'none'
  const toEnd = edge.toEnd ?? 'arrow'

  if (!fromNode || !toNode) {
    const origin = { x: 0, y: 0 }
    return {
      kind: 'edge',
      id: edge.id,
      path: [origin, origin],
      fromSide: edge.fromSide ?? 'right',
      toSide: edge.toSide ?? 'left',
      fromEnd,
      toEnd,
    }
  }

  const fromRect = rectOf(fromNode)
  const toRect = rectOf(toNode)

  // Self-edge: no meaningful "other node" direction, so fix a stable loop
  // shape (right side out, right side back) rather than deriving from a
  // zero center-offset.
  if (edge.fromNode === edge.toNode) {
    const fromSide: Side = edge.fromSide ?? 'right'
    const toSide: Side = edge.toSide ?? 'right'
    const start = sidePoint(fromRect, fromSide)
    const [loopOut, loopBack] = selfEdgeLoopControlPoints(start, fromSide)
    const end = sidePoint(toRect, toSide)
    return {
      kind: 'edge',
      id: edge.id,
      path: [start, loopOut, loopBack, end],
      fromSide,
      toSide,
      fromEnd,
      toEnd,
    }
  }

  const derived = deriveDefaultSides(fromRect, toRect)
  const fromSide = edge.fromSide ?? derived.fromSide
  const toSide = edge.toSide ?? derived.toSide

  const start = sidePoint(fromRect, fromSide)
  const end = sidePoint(toRect, toSide)
  const obstacles = nodes.filter((n) => n.id !== edge.fromNode && n.id !== edge.toNode).map(rectOf)

  return {
    kind: 'edge',
    id: edge.id,
    // 'curved' is accepted by the model but has no rendering yet: the scene
    // graph carries edges as a point path and the SVG backend draws them as a
    // <polyline>, so control points would render as corners. Until the
    // backend can express a curve it routes as 'straight' rather than
    // pretending — see the routing-style slice notes.
    path:
      style === 'orthogonal'
        ? routeOrthogonal(start, end, fromSide, toSide, obstacles)
        : routeStraight(start, end, obstacles),
    fromSide,
    toSide,
    fromEnd,
    toEnd,
  }
}
