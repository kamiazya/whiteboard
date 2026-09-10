/**
 * This plugin's contributed edge ROUTER: the one that draws through bends a
 * document stores, rather than computing a path.
 *
 * It is what the router contribution point is for. The built-in routings
 * (straight, orthogonal, curved) all COMPUTE a path from the two boxes and
 * the obstacles between them, so none of them can honour a point a person
 * placed by hand — and JSON Canvas has no waypoint to put one in. The bends
 * live in `visual.path/v0`, this plugin's own facet, and this router draws
 * them.
 */
import type {
  BoundingBox,
  EdgeRoute,
  EdgeRouter,
  EdgeSide,
  ScenePoint,
} from '@kamiazya/whiteboard-scene'
import { resolveEdgeWaypoints } from './data.js'

/** The bare name this router registers under; the renderer namespaces it. */
export const WAYPOINT_ROUTER = 'waypoints'

/** The midpoint of one side of a box — where an end sits when nothing moved it. */
function sideMidpoint(box: BoundingBox, side: EdgeSide): ScenePoint {
  switch (side) {
    case 'top':
      return { x: box.x + box.w / 2, y: box.y }
    case 'bottom':
      return { x: box.x + box.w / 2, y: box.y + box.h }
    case 'left':
      return { x: box.x, y: box.y + box.h / 2 }
    case 'right':
      return { x: box.x + box.w, y: box.y + box.h / 2 }
  }
}

/**
 * The border point facing `toward`, for the case where the anchor pass
 * resolved no side at all.
 *
 * The point is clamped onto the box and then pushed out to whichever border
 * it is nearest, so a bend directly above a node leaves through its top
 * rather than through a side picked by a default.
 */
function facing(box: BoundingBox, toward: ScenePoint): ScenePoint {
  const x = Math.min(Math.max(toward.x, box.x), box.x + box.w)
  const y = Math.min(Math.max(toward.y, box.y), box.y + box.h)
  const gaps: readonly (readonly [number, ScenePoint])[] = [
    [y - box.y, { x, y: box.y }],
    [box.y + box.h - y, { x, y: box.y + box.h }],
    [x - box.x, { x: box.x, y }],
    [box.x + box.w - x, { x: box.x + box.w, y }],
  ]
  let best = gaps[0] as readonly [number, ScenePoint]
  for (const gap of gaps) if (gap[0] < best[0]) best = gap
  return best[1]
}

/**
 * Where the route meets one endpoint: the anchor pass's own point when the
 * fan-out moved it, else the midpoint of the side it chose, else the border
 * facing the bend next to it.
 *
 * The chosen SIDE is honoured rather than re-derived from the first bend.
 * That pass sees the whole edge set — crowding, fan-out lanes, crossings —
 * and a router looking at one edge cannot improve on it; an edge that wants
 * a particular side says so through JSON Canvas's own `fromSide`/`toSide`,
 * which the pass already reads.
 */
function endpoint(
  box: BoundingBox,
  anchor: ScenePoint | undefined,
  side: EdgeSide | undefined,
  toward: ScenePoint,
): ScenePoint {
  if (anchor !== undefined) return anchor
  if (side !== undefined) return sideMidpoint(box, side)
  return facing(box, toward)
}

/**
 * Draws the edge's stored bends, or declines.
 *
 * Declining covers both an edge with no bends — the overwhelming majority,
 * and the reason `readRouting` filters first — and a payload the facet's own
 * schema refuses, where drawing part of a path would be worse than drawing
 * the computed one.
 */
export const waypointRouter: EdgeRouter = (request): EdgeRoute | null => {
  const waypoints = resolveEdgeWaypoints(request.edge)
  const first = waypoints[0]
  const last = waypoints[waypoints.length - 1]
  if (first === undefined || last === undefined) return null
  return {
    path: [
      endpoint(request.from, request.anchors?.from, request.anchors?.fromSide, first),
      ...waypoints,
      endpoint(request.to, request.anchors?.to, request.anchors?.toSide, last),
    ],
  }
}
