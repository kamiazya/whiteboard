/**
 * The ROUTER: one edge's path between two placed anchors, around the boxes
 * in its way. The authored-bend route, the self-loop, the straight style's
 * stub-and-chord, and the orthogonal style's zero-bend slide (`side-slides.ts`), elbow
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
import { contactRoute } from './edge-contact.js'
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
  unionRect,
  withoutRepeats,
} from './edge-geometry.js'
import { bendCount, interiorInkThrough, type SidePair } from './edge-rules.js'
import type { EdgeAnchorPair } from './edge-sides.js'
import { deriveDefaultSides, ORTHOGONAL_STUB_PX, selfEdgeLoopControlPoints } from './edge-sides.js'
import { routeOnGrid } from './grid-route.js'
import type { RouteEnds, RouteObstacles } from './route-ends.js'
import type { RoutingBudget } from './routing-budget.js'
import {
  deepenedCorridor,
  slideAlongSide,
  slidForApproach,
  tryZeroBendSlide,
} from './side-slides.js'
import {
  approachesSideways,
  cornerDetour,
  type DetourObstacle,
  squareEnds,
  strictInterior,
} from './straight-detour.js'

/** How close a route may pass to a foreign node's border, in px. */
const ROUTE_MARGIN_PX = 8

/**
 * How close a route may pass to a frame's title, in px. Less than a box's
 * margin: the text's measured box already ends where its last glyph does,
 * and a box's margin made a line passing just beyond a title's end turn
 * aside for it.
 */
const LABEL_MARGIN_PX = 2

/** How far a detour keeps clear of the boxes it steps around, in px. */
const OBSTACLE_CLEARANCE_PX = 16

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

/**
 * How far past the region a detour waypoint is placed. `routeOrthogonal`
 * prunes its obstacle set to the box a candidate path can reach, and that
 * box has to include this margin — a prune that stopped at the region
 * dropped obstacles a detour still ran into. Exported so the bound is pinned
 * by a test rather than by two call sites agreeing from memory.
 */
export const DETOUR_REACH_PX = OBSTACLE_CLEARANCE_PX

/** Ways past a blocking region: over it, under it, left of it, right of it. */
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

/**
 * A path from `start` to `end` that steps around what is in its way.
 *
 * The direct segment when nothing blocks it; otherwise the shortest path
 * through the corners of the boxes actually in the way (`cornerDetour`), which
 * keeps a straight connection as close to one line as the board allows. The
 * edge's own two boxes are in that search too, tested by their strict
 * interior, so a turn never takes the line back through the box it leaves or
 * the one it reaches.
 *
 * When the side search asked for `around` (the corner route crossed another
 * edge that the outer lane does not), or the corner search finds nothing
 * within its budget, four candidates
 * round the box covering everything in the way — over, under, left of, right
 * of it — and the shortest clear one wins; if none is clear the shortest is
 * used anyway, because layout has to return SOMETHING and a route that still
 * crosses is better than a thrown error or a straight line through
 * everything.
 */
function routeStraight(
  start: Point,
  end: Point,
  inflated: readonly Rect[],
  raw: readonly Rect[],
  endpointRects: readonly Rect[],
  around: boolean,
): Point[] {
  const region = blockingRegion(start, end, inflated)
  if (region === undefined) return [start, end]
  if (around) return bestCandidate(detourCandidates(start, end, region), inflated, raw)
  const obstacles: DetourObstacle[] = [
    ...inflated.map((block, i) => ({ block, body: raw[i] as Rect, escapable: true })),
    ...endpointRects.map((body) => ({ block: strictInterior(body), body, escapable: false })),
  ]
  return (
    cornerDetour(start, end, obstacles, OBSTACLE_CLEARANCE_PX) ??
    bestCandidate(detourCandidates(start, end, region), inflated, raw)
  )
}

/**
 * The straight style, with a perpendicular stub inserted at any end whose
 * direct segment would graze along its own side (see `approachesSideways`).
 * With neither end sideways this is exactly `routeStraight`, so every
 * facing-pair canvas keeps its two-point segment. When exactly one end is
 * sideways, the clean end's anchor slides along its own side to meet the
 * stub corridor squarely — one long axis-aligned run plus one right-angle
 * turn, instead of a diagonal into the stub. Only when that run is clear: a
 * slid anchor that still has to detour buys no straight run, and moving it
 * can land it on another edge's anchor on the same side, which the anchor
 * pass spread apart and the router cannot see.
 */
function routeStraightWithApproach(
  ends: RouteEnds,
  { inflated, raw }: RouteObstacles,
  around: boolean,
): Point[] {
  const {
    start,
    end,
    from: { side: fromSide, rect: fromRect, depth: fromDepth },
    to: { side: toSide, rect: toRect, depth: toDepth },
  } = ends
  const own = [fromRect, toRect]
  // Stepping round leaves and arrives along the sides' normals: from the
  // anchor itself its first leg runs along the box's own border whenever
  // the lane it heads for is above or below it.
  if (around && blockingRegion(start, end, inflated) !== undefined) {
    const exit = stubFrom(start, fromSide, fromDepth)
    const entry = stubFrom(end, toSide, toDepth)
    return withoutRepeats([start, ...routeStraight(exit, entry, inflated, raw, own, true), end])
  }
  // Every shape below can bend at a corner beside one of its boxes and meet
  // that box edge-on, whichever end already took a stub: an end that did
  // leaves along its normal, so squaring touches only the other.
  return squareEnds(approachedPath(ends, { inflated, raw }, around), {
    exit: stubFrom(start, fromSide, fromDepth),
    entry: stubFrom(end, toSide, toDepth),
    fromSide,
    toSide,
    clear: (a, b) =>
      blockingRegion(a, b, inflated) === undefined &&
      !own.some((rect) => segmentCrossesRect(a, b, strictInterior(rect))),
  })
}

/** `routeStraightWithApproach`'s path before its glancing ends are squared. */
function approachedPath(
  {
    start,
    end,
    from: { side: fromSide, rect: fromRect, depth: fromDepth },
    to: { side: toSide, rect: toRect, depth: toDepth },
  }: RouteEnds,
  { inflated, raw }: RouteObstacles,
  around: boolean,
): Point[] {
  const own = [fromRect, toRect]
  const fromSideways = approachesSideways(start, end, fromSide)
  const toSideways = approachesSideways(end, start, toSide)
  if (!fromSideways && !toSideways) return routeStraight(start, end, inflated, raw, own, around)
  // The straight run from a slid anchor, or undefined when there is none.
  const clearRun = (from: Point | undefined, to: Point | undefined): Point[] | undefined => {
    if (from === undefined || to === undefined) return undefined
    const run = routeStraight(from, to, inflated, raw, own, around)
    return run.length === 2 ? run : undefined
  }
  if (toSideways && !fromSideways) {
    const entry = stubFrom(end, toSide, toDepth)
    const run = clearRun(slideAlongSide(start, fromRect, fromSide, entry), entry)
    if (run !== undefined) return withoutRepeats([...run, end])
  }
  if (fromSideways && !toSideways) {
    const exit = stubFrom(start, fromSide, fromDepth)
    const run = clearRun(exit, slideAlongSide(end, toRect, toSide, exit))
    if (run !== undefined) return withoutRepeats([start, ...run])
  }
  const exit = fromSideways ? stubFrom(start, fromSide, fromDepth) : start
  const entry = toSideways ? stubFrom(end, toSide, toDepth) : end
  return withoutRepeats([start, ...routeStraight(exit, entry, inflated, raw, own, around), end])
}
function stubFrom(point: Point, side: EdgeSide, depth: number = ORTHOGONAL_STUB_PX): Point {
  const normal = outwardNormal(side)
  return {
    x: point.x + normal.x * depth,
    y: point.y + normal.y * depth,
  }
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
  {
    start: startAnchor,
    end,
    from: { side: fromSide, rect: fromRect, depth: fromDepth },
    to: { side: toSide, rect: toRect, depth: toDepth },
  }: RouteEnds,
  { inflated, raw }: RouteObstacles,
  budget: RoutingBudget | undefined,
): Point[] {
  let start = startAnchor
  // Both anchors can land on the same point — a member flush with a border
  // of the box holding it, wired to that border. (Boxes that merely touch
  // never get here: `contactRoute` draws them.) There is no distance to
  // route: the connection IS that point. Everything below assumes a direction to leave and arrive
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
  const around = [...raw, ...endpointRects]
  const searched = routeOnGrid(exit, entry, around, OBSTACLE_CLEARANCE_PX, budget)
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
 * The straight style keeps a box an anchor merely TOUCHES: its corner search
 * escapes a box by its strict interior, so a line can leave a border point
 * and still go round the body behind it — and the side search's cost model
 * already prices ink through such a box, so dropping it made the two
 * disagree. The orthogonal routes test clearance inclusively and keep the
 * older rule.
 *
 * `labels` (a frame's title) join the list on the same terms as a node: text
 * drawn outside every box is as much in the way as a box.
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
  labels: readonly Rect[],
  touchedBlocks: boolean,
): RouteObstacles {
  const fromId = endNode(edge.from)
  const toId = endNode(edge.to)
  const boxes = others ?? nodes.filter((n) => n.id !== fromId && n.id !== toId).map(rectOf)
  const holds = touchedBlocks ? strictlyContains : containsPoint
  const clear = (rect: Rect) => !holds(rect, start) && !holds(rect, end)
  const grown = (margin: number) => (rect: Rect) => ({
    x: rect.x - margin,
    y: rect.y - margin,
    w: rect.w + 2 * margin,
    h: rect.h + 2 * margin,
  })
  const rawBoxes = boxes.filter(clear)
  const inflatedBoxes = rawBoxes.map(grown(ROUTE_MARGIN_PX))
  // Built only when there is something to add: this runs per trial routing,
  // and copying the whole node list for nothing showed in the bench.
  if (labels.length === 0) return { raw: rawBoxes, inflated: inflatedBoxes }
  const rawLabels = labels.filter(clear)
  return {
    raw: [...rawBoxes, ...rawLabels],
    inflated: [...inflatedBoxes, ...rawLabels.map(grown(LABEL_MARGIN_PX))],
  }
}

function strictlyContains(rect: Rect, point: Point): boolean {
  return (
    point.x > rect.x && point.x < rect.x + rect.w && point.y > rect.y && point.y < rect.y + rect.h
  )
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
  // The layout's account for grid searches (`routing-budget.ts`); omitted,
  // this route's grid search is unbounded.
  budget?: RoutingBudget,
  // Text outside every node rect a route must not cross (a frame's title),
  // measured by the layout since routing is measure-free.
  labels: readonly Rect[] = [],
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

  const contact = contactRoute(edge, fromRect, toRect, fromEnd, toEnd)
  if (contact !== undefined) return contact

  const { fromSide, toSide } = resolvedSides(nodes, edge, fromRect, toRect, anchors)

  const start = anchors?.from ?? sidePoint(fromRect, fromSide)
  const end = anchors?.to ?? sidePoint(toRect, toSide)
  const strict = style === 'straight'
  const obstacleSet = routeObstacles(nodes, edge, start, end, others, labels, strict)
  const ends: RouteEnds = {
    start,
    end,
    from: {
      side: fromSide,
      rect: fromRect,
      depth: anchors?.fromLaneDepth ?? ORTHOGONAL_STUB_PX,
    },
    to: { side: toSide, rect: toRect, depth: anchors?.toLaneDepth ?? ORTHOGONAL_STUB_PX },
  }

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
        ? routeStraightWithApproach(ends, obstacleSet, anchors?.around === true)
        : routeOrthogonal(ends, obstacleSet, budget),
    ...(style === 'curved' ? { rounded: true as const } : {}),
    fromSide,
    toSide,
    fromEnd,
    toEnd,
  }
}
