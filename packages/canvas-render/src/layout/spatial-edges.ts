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

/** Border-inclusive: a point sitting exactly on the rect's edge counts as inside. */
function containsPoint(rect: Rect, point: Point): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.w &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.h
  )
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

/** Strict interior: a point exactly on the border is NOT inside, so a node
 * merely touching another (tidy adjacent layouts) never reads as occluding. */
function strictlyInside(rect: Rect, point: Point): boolean {
  return (
    point.x > rect.x && point.x < rect.x + rect.w && point.y > rect.y && point.y < rect.y + rect.h
  )
}

function fullyContains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  )
}

function oppositeSide(side: Side): Side {
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

/**
 * Side preference for the FROM end, best first: the side facing the other
 * node on the dominant axis (the pre-existing default, so an unoccluded
 * canvas keeps its exact old sides), then the facing side of the other
 * axis, then their opposites. Ties (equal offsets) prefer the horizontal
 * axis — the same fixed tie-breaker the default derivation always had.
 */
function facingSides(dx: number, dy: number): readonly [Side, Side, Side, Side] {
  const h: Side = dx >= 0 ? 'right' : 'left'
  const v: Side = dy >= 0 ? 'bottom' : 'top'
  return Math.abs(dx) >= Math.abs(dy)
    ? [h, v, oppositeSide(v), oppositeSide(h)]
    : [v, h, oppositeSide(h), oppositeSide(v)]
}

/**
 * Deterministic default-side derivation for an edge with no explicit
 * fromSide/toSide, occlusion-aware: the preferred side is the pre-existing
 * center-offset derivation, but a side whose midpoint anchor sits strictly
 * INSIDE another node is skipped for the first exposed one. The endpoint
 * rects themselves are never obstacles (the edge has to reach them), so an
 * occluded anchor means the route legally cuts straight through the
 * occluding node — moving to an exposed side is what keeps it outside.
 *
 * Not occluders: the edge's other endpoint (entering the shared region IS
 * the edge's job), and any rect fully containing the endpoint node (a
 * group frame around its member occludes every side equally, which says
 * nothing about which side to prefer). With every side occluded the
 * derivation falls back to the preferred side, so fully-boxed-in nodes
 * keep the old behaviour.
 */
function deriveDefaultSides(
  nodes: readonly SpatialNode[],
  edge: CanvasEdge,
  fromRect: Rect,
  toRect: Rect,
): { fromSide: Side; toSide: Side } {
  const fromCenter = centerOf(fromRect)
  const toCenter = centerOf(toRect)
  const dx = toCenter.x - fromCenter.x
  const dy = toCenter.y - fromCenter.y
  const fromCandidates = facingSides(dx, dy)
  // The to end's preferences mirror the from end's (the old derivation
  // always returned opposite pairs), each end then skipping occlusion
  // independently.
  const toCandidates = fromCandidates.map(oppositeSide) as unknown as readonly [
    Side,
    Side,
    Side,
    Side,
  ]
  const foreign = nodes.filter((n) => n.id !== edge.fromNode && n.id !== edge.toNode).map(rectOf)
  const pick = (rect: Rect, candidates: readonly Side[]): Side => {
    const occluders = foreign.filter((r) => !fullyContains(r, rect))
    return (
      candidates.find((side) => !occluders.some((r) => strictlyInside(r, sidePoint(rect, side)))) ??
      candidates[0]!
    )
  }
  return { fromSide: pick(fromRect, fromCandidates), toSide: pick(toRect, toCandidates) }
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

/** An edge's resolved endpoint positions, when the fan-out pass moved them. */
export interface EdgeAnchorPair {
  readonly from?: Point
  readonly to?: Point
}

/** The coordinate that orders ends along a side: y on vertical sides, x on horizontal. */
function tangentCoordinate(side: Side, point: Point): number {
  return side === 'left' || side === 'right' ? point.y : point.x
}

/** The point a fraction of the way along a side, 0 at its top/left end. */
function sidePointAt(rect: Rect, side: Side, fraction: number): Point {
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
 * Deterministic anchor positions for every edge end, spreading the ends
 * that share one (node, side) instead of stacking them all on the side's
 * midpoint. JSON Canvas authors a side but never a position along it, so
 * the position is the renderer's to choose — and a stack of ends at one
 * point makes edges with different colors or arrowheads read as a single
 * line until they diverge.
 *
 * Within a shared side, ends sit at fractions 1/(n+1) … n/(n+1), ordered
 * by where the FAR endpoint's center lies along the side's tangent axis so
 * routes leave in the order of their destinations and never cross right at
 * the node; ties (same far node, e.g. a bidirectional pair) fall back to
 * edge document order, then from-before-to. A side with a single end keeps
 * its midpoint, so canvases without shared sides render exactly as before.
 *
 * Edges with a missing endpoint get no entry — `routeEdge` already
 * degrades those to a zero-length path on its own.
 */
export function assignEdgeAnchors(
  nodes: readonly SpatialNode[],
  edges: readonly CanvasEdge[],
): ReadonlyMap<string, EdgeAnchorPair> {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  type End = {
    readonly edgeId: string
    readonly edgeIndex: number
    readonly role: 'from' | 'to'
    readonly rect: Rect
    readonly side: Side
    readonly farCenter: Point
  }
  const groups = new Map<string, End[]>()
  edges.forEach((edge, edgeIndex) => {
    const fromNode = byId.get(edge.fromNode)
    const toNode = byId.get(edge.toNode)
    if (fromNode === undefined || toNode === undefined) return
    const fromRect = rectOf(fromNode)
    const toRect = rectOf(toNode)
    const derived =
      edge.fromNode === edge.toNode
        ? { fromSide: 'right' as Side, toSide: 'right' as Side }
        : deriveDefaultSides(nodes, edge, fromRect, toRect)
    const ends: End[] = [
      {
        edgeId: edge.id,
        edgeIndex,
        role: 'from',
        rect: fromRect,
        side: edge.fromSide ?? derived.fromSide,
        farCenter: centerOf(toRect),
      },
      {
        edgeId: edge.id,
        edgeIndex,
        role: 'to',
        rect: toRect,
        side: edge.toSide ?? derived.toSide,
        farCenter: centerOf(fromRect),
      },
    ]
    for (const end of ends) {
      const key = `${end.role === 'from' ? edge.fromNode : edge.toNode} ${end.side}`
      const group = groups.get(key)
      if (group === undefined) groups.set(key, [end])
      else group.push(end)
    }
  })

  const anchors = new Map<string, { from?: Point; to?: Point }>()
  for (const group of groups.values()) {
    group.sort(
      (a, b) =>
        tangentCoordinate(a.side, a.farCenter) - tangentCoordinate(b.side, b.farCenter) ||
        a.edgeIndex - b.edgeIndex ||
        (a.role === b.role ? 0 : a.role === 'from' ? -1 : 1),
    )
    group.forEach((end, i) => {
      const point = sidePointAt(end.rect, end.side, (i + 1) / (group.length + 1))
      const entry = anchors.get(end.edgeId) ?? {}
      anchors.set(
        end.edgeId,
        end.role === 'from' ? { ...entry, from: point } : { ...entry, to: point },
      )
    })
  }
  return anchors
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

  const elbows = [between([{ x: entry.x, y: exit.y }]), between([{ x: exit.x, y: entry.y }])]
  if (elbows.some((path) => pathIsClear(path, obstacles))) {
    return bestCandidate(elbows, obstacles)
  }

  // Detours are needed when the paths this style actually travels are
  // blocked — which the direct diagonal cannot answer, since an orthogonal
  // edge never travels it. Two obstacles can sit on the two elbows while
  // leaving that diagonal clear.
  const region = unionRect(
    obstacles.filter((rect) =>
      elbows.some((path) =>
        path.some((point, i) => i > 0 && segmentCrossesRect(path[i - 1] as Point, point, rect)),
      ),
    ),
  )
  const candidates =
    region === undefined
      ? elbows
      : [
          ...elbows,
          ...detourCandidates(exit, entry, region).map((path) => between(path.slice(1, -1))),
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
  // Endpoint override from `assignEdgeAnchors`'s fan-out pass; an absent
  // field keeps the side midpoint, so single callers stay unchanged.
  anchors?: EdgeAnchorPair,
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
    const start = anchors?.from ?? sidePoint(fromRect, fromSide)
    const [loopOut, loopBack] = selfEdgeLoopControlPoints(start, fromSide)
    const end = anchors?.to ?? sidePoint(toRect, toSide)
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

  const derived = deriveDefaultSides(nodes, edge, fromRect, toRect)
  const fromSide = edge.fromSide ?? derived.fromSide
  const toSide = edge.toSide ?? derived.toSide

  const start = anchors?.from ?? sidePoint(fromRect, fromSide)
  const end = anchors?.to ?? sidePoint(toRect, toSide)
  // A rect that contains an endpoint can never be routed around — every
  // detour still has to reach the point inside it — so it is not an
  // obstacle. This is what lets an edge between two members of a group run
  // inside the group's frame instead of detouring around it.
  const obstacles = nodes
    .filter((n) => n.id !== edge.fromNode && n.id !== edge.toNode)
    .map(rectOf)
    .filter((rect) => !containsPoint(rect, start) && !containsPoint(rect, end))

  return {
    kind: 'edge',
    id: edge.id,
    // 'curved' travels the same waypoints as 'orthogonal' — perpendicular
    // exit and entry, obstacles stepped around — and differs only in asking
    // for those corners to be drawn rounded. Keeping one set of waypoints is
    // what makes the two styles agree about which nodes an edge avoids; only
    // the drawing differs.
    path:
      style === 'straight'
        ? routeStraight(start, end, obstacles)
        : routeOrthogonal(start, end, fromSide, toSide, obstacles),
    ...(style === 'curved' ? { rounded: true as const } : {}),
    fromSide,
    toSide,
    fromEnd,
    toEnd,
  }
}
