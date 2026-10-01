/**
 * The ROUTER: one edge's path between two placed anchors, around the boxes
 * in its way. The authored-bend route, the self-loop, the straight style's
 * stub-and-chord, and the orthogonal style's zero-bend slide, elbow
 * candidates, detours and Hanan-grid search (`grid-route.ts`) — `routeEdge`
 * chooses among them and never throws (a missing endpoint degrades to a
 * zero-length path).
 *
 * Reads the side vocabulary (`edge-sides.ts`), the geometry and the ink
 * terms; it does not know the search exists. The search
 * (`spatial-edges.ts`) calls it per trial and caches by `routeCacheKey`.
 */

import type { EdgeRoutingStyle, EdgeSide, SpatialNode } from '@kamiazya/whiteboard-model'
import { endNode, endSide, isSelfLoop } from '@kamiazya/whiteboard-model'
import type { ResolvedEdgeNode, RoutableElement } from '@kamiazya/whiteboard-scene'
import { bendRoute } from './bend-route.js'
import type { Point, Rect } from './edge-geometry.js'
import {
  boundingBoxOf,
  containsPoint,
  outwardNormal,
  pathIsClear,
  pathLength,
  rectAtEnd,
  rectOf,
  segmentCrossesRect,
  sidePoint,
  tangentCoordinate,
  unionRect,
  withoutRepeats,
} from './edge-geometry.js'
import {
  bendCount,
  interiorInkThrough,
  oppositeSide,
  type SidePair,
  SLIDE_CORNER_INSET_PX,
} from './edge-rules.js'
import type { EdgeAnchorPair } from './edge-sides.js'
import { deriveDefaultSides, ORTHOGONAL_STUB_PX, selfEdgeLoopControlPoints } from './edge-sides.js'
import { routeOnGrid } from './grid-route.js'

/** How close a route may pass to a foreign node's border, in px. */
const ROUTE_MARGIN_PX = 8

/** How far a detour keeps clear of the boxes it steps around, in px. */
const OBSTACLE_CLEARANCE_PX = 16

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
/**
 * The best candidate by a two-tier clearance ranking, shortest first:
 * clear of the inflated obstacles (full margin kept), else clear of the
 * RAW node bodies (an anchor boxed inside a neighbour's margin band has
 * to cross the band to escape — that is acceptable; crossing the node
 * itself is not), else the shortest overall (layout has to return
 * SOMETHING).
 *
 * Equal-length candidates are ranked by BEND COUNT: the two stub-to-stub
 * elbows are always the same Manhattan length, so without this key the
 * arbitrary first candidate won even when the other ran collinear with
 * both stubs and drew one corner instead of three.
 */
function bestCandidate(
  candidates: readonly Point[][],
  inflated: readonly Rect[],
  raw: readonly Rect[],
  endpointRects: readonly Rect[] = [],
): Point[] {
  // Scored once per candidate, not once per comparison: this runs per edge
  // on every layout, inside an optimizer that reroutes the whole edge set
  // several times.
  const scored = candidates.map((path) => ({
    path,
    ink: interiorInkThrough(path, endpointRects),
    length: pathLength(path),
    bends: bendCount(path),
  }))
  const ranked = scored
    .sort((a, b) => {
      if (a.ink !== b.ink) return a.ink - b.ink
      if (Math.abs(a.length - b.length) > 1e-6) return a.length - b.length
      return a.bends - b.bends
    })
    .map((c) => c.path)
  return (
    ranked.find((path) => pathIsClear(path, inflated)) ??
    ranked.find((path) => pathIsClear(path, raw)) ??
    (ranked[0] as Point[])
  )
}

/** Ways past a blocking region: over it, under it, left of it, right of it. */
/**
 * How far past the region a detour waypoint is placed. `routeOrthogonal`
 * prunes its obstacle set to the box a candidate path can reach, and that
 * box has to include this margin — a prune that stopped at the region
 * dropped obstacles a detour still ran into. Exported so the bound is pinned
 * by a test rather than by two call sites agreeing from memory.
 */
export const DETOUR_REACH_PX = OBSTACLE_CLEARANCE_PX

export function detourCandidates(start: Point, end: Point, region: Rect): Point[][] {
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

function routeStraight(
  start: Point,
  end: Point,
  inflated: readonly Rect[],
  raw: readonly Rect[],
): Point[] {
  const region = blockingRegion(start, end, inflated)
  if (region === undefined) return [start, end]
  return bestCandidate(detourCandidates(start, end, region), inflated, raw)
}

/**
 * Whether a straight run from `anchor` toward `other` would leave through
 * the anchor side's outward half-plane. When it would not (the direction
 * grazes along the side or points back across the node — the shape an
 * occlusion-moved side produces), the edge needs a perpendicular stub
 * first, or it draws sliding along the node's own border and the arrowhead
 * meets the side edge-on.
 */
/** Below this outward-to-tangential ratio (~14°), an approach reads as
 * running along the side rather than into it. */
const SIDEWAYS_RATIO = 0.25

function approachesSideways(anchor: Point, other: Point, side: EdgeSide): boolean {
  const vx = other.x - anchor.x
  const vy = other.y - anchor.y
  // Coincident anchors have no direction to graze along — the degenerate
  // zero-length path stays minimal rather than growing stubs.
  if (vx === 0 && vy === 0) return false
  const normal = outwardNormal(side)
  const outward = normal.x * vx + normal.y * vy
  const tangential = Math.abs(normal.x * vy - normal.y * vx)
  return outward <= tangential * SIDEWAYS_RATIO
}

/**
 * The anchor slid along its side so the run to `target` is axis-aligned,
 * or undefined when the target's coordinate falls outside the side's span
 * (keeping a corner inset). A side midpoint is a default, not authored
 * data — trading it for a rectilinear route is the better-looking edge.
 */
function slideAlongSide(
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
 * The straight style, with a perpendicular stub inserted at any end whose
 * direct segment would graze along its own side (see `approachesSideways`).
 * With neither end sideways this is exactly `routeStraight`, so every
 * facing-pair canvas keeps its two-point segment. When exactly one end is
 * sideways, the clean end's anchor slides along its own side to meet the
 * stub corridor squarely — one long axis-aligned run plus one right-angle
 * turn, instead of a diagonal into the stub.
 */
function routeStraightWithApproach(
  start: Point,
  end: Point,
  fromSide: EdgeSide,
  toSide: EdgeSide,
  fromRect: Rect,
  toRect: Rect,
  fromDepth: number,
  toDepth: number,
  inflated: readonly Rect[],
  raw: readonly Rect[],
): Point[] {
  const fromSideways = approachesSideways(start, end, fromSide)
  const toSideways = approachesSideways(end, start, toSide)
  if (!fromSideways && !toSideways) return routeStraight(start, end, inflated, raw)
  if (toSideways && !fromSideways) {
    const entry = stubFrom(end, toSide, toDepth)
    const slid = slideAlongSide(start, fromRect, fromSide, entry)
    if (slid !== undefined) {
      return withoutRepeats([...routeStraight(slid, entry, inflated, raw), end])
    }
  }
  if (fromSideways && !toSideways) {
    const exit = stubFrom(start, fromSide, fromDepth)
    const slid = slideAlongSide(end, toRect, toSide, exit)
    if (slid !== undefined) {
      return withoutRepeats([start, ...routeStraight(exit, slid, inflated, raw)])
    }
  }
  const exit = fromSideways ? stubFrom(start, fromSide, fromDepth) : start
  const entry = toSideways ? stubFrom(end, toSide, toDepth) : end
  return withoutRepeats([start, ...routeStraight(exit, entry, inflated, raw), end])
}
function stubFrom(point: Point, side: EdgeSide, depth: number = ORTHOGONAL_STUB_PX): Point {
  const normal = outwardNormal(side)
  return {
    x: point.x + normal.x * depth,
    y: point.y + normal.y * depth,
  }
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
/**
 * Zero-bend shortcut: two ends on OPPOSING, mutually facing sides can often
 * share one tangent coordinate — anchors are renderer-chosen defaults, so
 * sliding one end along its side buys a single straight segment instead of
 * a stub-jog-stub elbow. Facing is required (each side's outward normal
 * points toward the other end), or an authored opposing pair with the nodes
 * swapped would draw a line backwards through both. A blocked lane answers
 * undefined and the caller falls through to the elbows.
 */
function tryZeroBendSlide(
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
/** The obstacles whose rects touch `box`, with the inflated and raw lists
 * kept in step — the two windowing passes in routeOrthogonal differ only in
 * the box they prune to. */
function windowObstacles(
  inflated: readonly Rect[],
  raw: readonly Rect[],
  box: Rect,
): { inflated: Rect[]; raw: Rect[] } {
  const touches = (r: Rect) =>
    r.x <= box.x + box.w && r.x + r.w >= box.x && r.y <= box.y + box.h && r.y + r.h >= box.y
  const near: { inflated: Rect[]; raw: Rect[] } = { inflated: [], raw: [] }
  for (let i = 0; i < inflated.length; i++) {
    if (touches(inflated[i] as Rect)) {
      near.inflated.push(inflated[i] as Rect)
      near.raw.push(raw[i] as Rect)
    }
  }
  return near
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
function slidForApproach(
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
function deepenedCorridor(
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

function routeOrthogonal(
  startAnchor: Point,
  end: Point,
  fromSide: EdgeSide,
  toSide: EdgeSide,
  fromRect: Rect,
  toRect: Rect,
  fromDepth: number,
  toDepth: number,
  inflated: readonly Rect[],
  raw: readonly Rect[],
): Point[] {
  let start = startAnchor
  // Boxes that touch exactly can put both anchors on the same point — two
  // flush-stacked nodes wired bottom-to-top land on the shared corner of
  // their fan-out spans. There is no distance to route: the connection IS
  // that point. Everything below assumes a direction to leave and arrive
  // along, and with none it built a stub each way, drawing a spike 20px
  // into one box and 40px back through both.
  //
  // ponytail: this draws nothing rather than the wrong thing. A VISIBLE
  // connector between flush boxes would have to leave from a face with room
  // beside it, which is a side-choice decision (`rankedSidePairs`), not
  // something this function can invent after the sides are fixed.
  if (start.x === end.x && start.y === end.y) return [start, end]
  const zeroBend = tryZeroBendSlide(start, end, fromSide, toSide, fromRect, toRect, inflated)
  if (zeroBend !== undefined) return zeroBend
  const toNormal = outwardNormal(toSide)
  start = slidForApproach(start, end, fromSide, toSide, fromRect, toNormal)
  fromDepth = deepenedCorridor(start, end, fromSide, toSide, fromDepth, toNormal)

  const exit = stubFrom(start, fromSide, fromDepth)
  const entry = stubFrom(end, toSide, toDepth)
  // The arrival stub exists so the last segment reaches the anchor from
  // OUTSIDE its side. When the elbow already sits outside, on the arrival
  // axis, the stub only buys a detour past the anchor and back — a 20px
  // excursion that reads as a hook and reverses direction on that axis.
  // The DEPARTURE stub is never dropped the same way: its depth is what
  // separates edges sharing one side into distinct corridors.
  const arrivesFromOutside = (point: Point) =>
    toNormal.x * (point.x - end.x) + toNormal.y * (point.y - end.y) > 0 &&
    (toNormal.x === 0 ? point.x === end.x : point.y === end.y)
  const between = (middles: readonly Point[]) => {
    const last = middles[middles.length - 1]
    const approach = last !== undefined && arrivesFromOutside(last) ? [] : [entry]
    return withoutRepeats([start, exit, ...middles, ...approach, end])
  }

  const endpointRects = [fromRect, toRect]
  const elbows = [between([{ x: entry.x, y: exit.y }]), between([{ x: exit.x, y: entry.y }])]

  // Everything below tests candidate paths against the obstacle set, six to
  // fifteen times per call: two elbow clearance tests, the `crossedBy` filter,
  // and `bestCandidate` up to three times, each walking its ranked candidates.
  // On a clustered canvas that set is every node but two -- 286 rects, nearly
  // all of them nowhere near this edge. `routeOnGrid` already prunes to a
  // window; nothing else did.
  //
  // Sound because every path this function can produce lives inside the box
  // below: the elbows are built from {start, exit, entry, end}, and a detour
  // is built from `detourCandidates(exit, entry, region)` where `region` is a
  // union of obstacles the elbows CROSS -- so it cannot reach an obstacle the
  // elbow box does not already touch.
  const elbowBox = boundingBoxOf(elbows.flat())
  // Stage one: what the elbows themselves can reach. Correct for the
  // clearance tests and for `crossedBy`, which only ever tests elbow segments.
  const { inflated: nearInflated, raw: nearRaw } = windowObstacles(inflated, raw, elbowBox)
  // An elbow is good enough to stop here only if it is clear of the FOREIGN
  // obstacles AND puts no ink inside its own endpoints. Testing foreign
  // clearance alone returned an elbow that tunnelled straight through the
  // target's body without ever generating a detour — the endpoint rects are
  // not obstacles, so nothing reported the route as blocked.
  if (
    elbows.some(
      (path) => pathIsClear(path, nearInflated) && interiorInkThrough(path, endpointRects) === 0,
    )
  ) {
    return bestCandidate(elbows, nearInflated, nearRaw, endpointRects)
  }

  // Detours are needed when the paths this style actually travels are
  // blocked — which the direct diagonal cannot answer, since an orthogonal
  // edge never travels it. Two obstacles can sit on the two elbows while
  // leaving that diagonal clear.
  //
  // An endpoint body the elbows cut through joins the region for the same
  // reason a foreign body does: it is what the route has to get around. It
  // can never be an obstacle for the CLEARANCE test — every route has to
  // reach a point on it — but it is a perfectly good thing to steer past.
  const crossedBy = (rect: Rect) =>
    elbows.some((path) =>
      path.some((point, i) => i > 0 && segmentCrossesRect(path[i - 1] as Point, point, rect)),
    )
  const region = unionRect([
    ...nearInflated.filter(crossedBy),
    ...endpointRects.filter((rect) => elbows.some((path) => interiorInkThrough(path, [rect]) > 0)),
  ])
  const candidates =
    region === undefined
      ? elbows
      : [
          ...elbows,
          ...detourCandidates(exit, entry, region).map((path) => between(path.slice(1, -1))),
        ]
  // Stage two: a detour reaches into `region`, so the working box grows to
  // cover it and the set is taken again from the full list.
  // Inflated by the detour clearance, because `detourCandidates` places its
  // waypoints OBSTACLE_CLEARANCE_PX OUTSIDE the region's edges — a box that
  // stops at the region drops obstacles a detour can still run into. The
  // routing scoreboard caught exactly that as changed routes.
  const detourReach = region === undefined ? undefined : (unionRect([elbowBox, region]) as Rect)
  const workBox =
    detourReach === undefined
      ? elbowBox
      : {
          x: detourReach.x - DETOUR_REACH_PX,
          y: detourReach.y - DETOUR_REACH_PX,
          w: detourReach.w + 2 * DETOUR_REACH_PX,
          h: detourReach.h + 2 * DETOUR_REACH_PX,
        }
  const { inflated: workInflated, raw: workRaw } = windowObstacles(inflated, raw, workBox)
  const enumerated = bestCandidate(candidates, workInflated, workRaw, endpointRects)
  if (interiorInkThrough(enumerated, endpointRects) === 0 && pathIsClear(enumerated, workRaw)) {
    return enumerated
  }
  // Nothing enumerated works, so pay for a real search. It runs between the
  // STUBS, not the anchors, so the perpendicular departure and arrival the
  // rest of this function guarantees survive it — the grid only decides what
  // happens in between.
  const searched = routeOnGrid(exit, entry, [...raw, ...endpointRects], OBSTACLE_CLEARANCE_PX)
  return searched === undefined
    ? enumerated
    : bestCandidate(
        [enumerated, between(searched.slice(1, -1))],
        workInflated,
        workRaw,
        endpointRects,
      )
}

/**
 * The stored path, when the person drawing this edge already gave one.
 *
 * Bends come FIRST, before the self-edge shape and before any computed
 * routing: the stored path is not one routing among the others, it is the
 * answer to "where does this edge go" that the author already gave, and a
 * computed route that ignored it would drop authored geometry while leaving
 * it in the record.
 *
 * The style still says how it is DRAWN, and the two are independent — the
 * same as the computed branch, where 'curved' is 'orthogonal' asking for
 * rounded corners. Freehand ink is what made that omission visible: a stroke
 * is all bends, so it came back as a chain of straight runs with a corner at
 * every sample the simplification kept.
 */
function authoredBendRoute(
  edge: RoutableElement,
  fromRect: Rect,
  toRect: Rect,
  anchors: EdgeAnchorPair | undefined,
  style: EdgeRoutingStyle,
  fromEnd: 'none' | 'arrow',
  toEnd: 'none' | 'arrow',
): ResolvedEdgeNode | undefined {
  const namedFromSide = anchors?.fromSide ?? endSide(edge.from)
  const namedToSide = anchors?.toSide ?? endSide(edge.to)
  const bent = bendRoute(edge, fromRect, toRect, {
    ...(anchors?.from === undefined ? {} : { from: anchors.from }),
    ...(anchors?.to === undefined ? {} : { to: anchors.to }),
    ...(namedFromSide === undefined ? {} : { fromSide: namedFromSide }),
    ...(namedToSide === undefined ? {} : { toSide: namedToSide }),
  })
  if (bent === undefined) return undefined
  return {
    kind: 'edge',
    id: edge.id,
    path: [...bent],
    ...(style === 'curved' ? { rounded: true as const } : {}),
    fromSide: namedFromSide ?? 'right',
    toSide: namedToSide ?? 'left',
    fromEnd,
    toEnd,
  }
}

/**
 * A self-edge has no meaningful "other node" direction, so it takes a stable
 * loop shape — right side out, right side back — rather than deriving one
 * from a zero centre offset.
 */
function selfLoopRoute(
  edge: RoutableElement,
  fromRect: Rect,
  toRect: Rect,
  anchors: EdgeAnchorPair | undefined,
  fromEnd: 'none' | 'arrow',
  toEnd: 'none' | 'arrow',
): ResolvedEdgeNode {
  const fromSide: EdgeSide = endSide(edge.from) ?? 'right'
  const toSide: EdgeSide = endSide(edge.to) ?? 'right'
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

/**
 * What this edge has to route around, raw and margin-inflated.
 *
 * A rect that CONTAINS an endpoint can never be routed around — every detour
 * still has to reach the point inside it — so it is not an obstacle. That is
 * what lets an edge between two members of a group run inside the group's
 * frame instead of detouring around it.
 *
 * Containment is tested on RAW bounds: a node whose margin band merely
 * brushes an anchor must still block the route from crossing its body.
 * Routing then tests the margin-inflated rects so a route keeps visible
 * clearance from foreign borders; when an anchor is boxed inside a
 * neighbour's margin band, `bestCandidate`'s second tier accepts a band
 * crossing to escape rather than tunnelling through the node itself.
 *
 * `others` is the caller's O(nodes) list handed over intact — the
 * side-choice search routes each edge many times per layout, and the ends do
 * not change inside it.
 */
function routeObstacles(
  nodes: readonly SpatialNode[],
  edge: RoutableElement,
  start: Point,
  end: Point,
  others: readonly Rect[] | undefined,
): { obstacles: Rect[]; rawObstacles: Rect[] } {
  const fromId = endNode(edge.from)
  const toId = endNode(edge.to)
  const rawObstacles = (
    others ?? nodes.filter((n) => n.id !== fromId && n.id !== toId).map(rectOf)
  ).filter((rect) => !containsPoint(rect, start) && !containsPoint(rect, end))
  return {
    rawObstacles,
    obstacles: rawObstacles.map((rect) => ({
      x: rect.x - ROUTE_MARGIN_PX,
      y: rect.y - ROUTE_MARGIN_PX,
      w: rect.w + 2 * ROUTE_MARGIN_PX,
      h: rect.h + 2 * ROUTE_MARGIN_PX,
    })),
  }
}

/**
 * An edge whose ends name no node this canvas holds. It still has to RESOLVE
 * — the layout is total — so it collapses to a zero-length path at the
 * origin rather than being dropped.
 */
function unplacedEdge(
  edge: RoutableElement,
  fromEnd: 'none' | 'arrow',
  toEnd: 'none' | 'arrow',
): ResolvedEdgeNode {
  const origin = { x: 0, y: 0 }
  return {
    kind: 'edge',
    id: edge.id,
    path: [origin, origin],
    fromSide: endSide(edge.from) ?? 'right',
    toSide: endSide(edge.to) ?? 'left',
    fromEnd,
    toEnd,
  }
}

/**
 * Which side each end leaves from, in precedence order.
 *
 * The anchor pass resolves sides with whole-edge-set crowding knowledge a
 * single call lacks, so when it spoke, follow it — it applies a named side
 * itself, and differs from one only where the search overruled a pair routed
 * through its own box, which has to reach the adopting trial and the render
 * alike.
 *
 * Deriving is an occlusion scan over every node, so it is deferred behind a
 * memo and runs only when a side is actually missing.
 */
function resolvedSides(
  nodes: readonly SpatialNode[],
  edge: RoutableElement,
  fromRect: Rect,
  toRect: Rect,
  anchors: EdgeAnchorPair | undefined,
): SidePair {
  let derived: SidePair | undefined
  const derive = () => (derived ??= deriveDefaultSides(nodes, edge, fromRect, toRect))
  return {
    fromSide: anchors?.fromSide ?? endSide(edge.from) ?? derive().fromSide,
    toSide: anchors?.toSide ?? endSide(edge.to) ?? derive().toSide,
  }
}

/**
 * Resolves one model edge into a scene-graph edge with a concrete
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
  edge: RoutableElement,
  style: EdgeRoutingStyle = 'straight',
  // Endpoint override from `assignEdgeAnchors`'s fan-out pass; an absent
  // field keeps the side midpoint, so single callers stay unchanged.
  anchors?: EdgeAnchorPair,
  // Every node's rect except the two endpoints', when the caller already
  // has them: the side-choice search routes each edge many times per
  // layout and this is the one O(nodes) list it can hand over intact.
  others?: readonly Rect[],
): ResolvedEdgeNode {
  const fromRect = rectAtEnd(nodes, edge.from)
  const toRect = rectAtEnd(nodes, edge.to)

  // JSON Canvas 1.0 defaults: no source arrowhead, a destination arrowhead.
  const fromEnd = edge.from.end ?? 'none'
  const toEnd = edge.to.end ?? 'arrow'

  if (fromRect === undefined || toRect === undefined) {
    return unplacedEdge(edge, fromEnd, toEnd)
  }

  const authored = authoredBendRoute(edge, fromRect, toRect, anchors, style, fromEnd, toEnd)
  if (authored !== undefined) return authored

  if (isSelfLoop(edge)) return selfLoopRoute(edge, fromRect, toRect, anchors, fromEnd, toEnd)

  const { fromSide, toSide } = resolvedSides(nodes, edge, fromRect, toRect, anchors)

  const start = anchors?.from ?? sidePoint(fromRect, fromSide)
  const end = anchors?.to ?? sidePoint(toRect, toSide)
  const { obstacles, rawObstacles } = routeObstacles(nodes, edge, start, end, others)

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
        ? routeStraightWithApproach(
            start,
            end,
            fromSide,
            toSide,
            fromRect,
            toRect,
            anchors?.fromLaneDepth ?? ORTHOGONAL_STUB_PX,
            anchors?.toLaneDepth ?? ORTHOGONAL_STUB_PX,
            obstacles,
            rawObstacles,
          )
        : routeOrthogonal(
            start,
            end,
            fromSide,
            toSide,
            fromRect,
            toRect,
            anchors?.fromLaneDepth ?? ORTHOGONAL_STUB_PX,
            anchors?.toLaneDepth ?? ORTHOGONAL_STUB_PX,
            obstacles,
            rawObstacles,
          ),
    ...(style === 'curved' ? { rounded: true as const } : {}),
    fromSide,
    toSide,
    fromEnd,
    toEnd,
  }
}
