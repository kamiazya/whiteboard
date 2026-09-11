/**
 * Drawing an edge through the bends it STORES, rather than computing a path.
 *
 * Every other routing here computes: it is handed two boxes and the obstacles
 * between them and works out a line. None of them can honour a point somebody
 * placed by hand, so this one is not a routing among the others — it is what
 * happens INSTEAD of choosing one, whenever the edge says where it goes.
 *
 * It lived in `plugin-visual` as a contributed router until
 * [ADR-0033](../../../../../docs/contributing/adr/0033-model-and-format.md)
 * slice 4, because JSON Canvas has no waypoint and the model was the format,
 * so the bends could only exist as a plugin's facet. With `bends` a field of
 * the edge, a renderer that ignored them would drop geometry a person
 * authored — silently, since the data would still be in the record. So the
 * renderer owns it. The `RenderContribution.routers` seam the old arrangement
 * built stays: it is a published contract, and it was the right seam even
 * though the concept it first carried turned out to be core.
 */
import type { CanvasEdge } from '@kamiazya/whiteboard-model'
import type { ScenePoint } from '@kamiazya/whiteboard-scene'
import { sidePoint } from './edge-geometry.js'
import type { Rect, Side } from './edge-rules.js'

/**
 * The border point facing `toward`, for an end whose side nothing resolved.
 *
 * The point is clamped onto the box and then pushed out to whichever border
 * it is nearest, so a bend directly above a node leaves through its top
 * rather than through a side picked by a default.
 */
function facing(rect: Rect, toward: ScenePoint): ScenePoint {
  const x = Math.min(Math.max(toward.x, rect.x), rect.x + rect.w)
  const y = Math.min(Math.max(toward.y, rect.y), rect.y + rect.h)
  const gaps: readonly (readonly [number, ScenePoint])[] = [
    [y - rect.y, { x, y: rect.y }],
    [rect.y + rect.h - y, { x, y: rect.y + rect.h }],
    [x - rect.x, { x: rect.x, y }],
    [rect.x + rect.w - x, { x: rect.x + rect.w, y }],
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
 * and this route, looking at one edge, cannot improve on it; an edge that
 * wants a particular side says so through JSON Canvas's own
 * `fromSide`/`toSide`, which the pass already reads.
 */
function endpoint(
  rect: Rect,
  anchor: ScenePoint | undefined,
  side: Side | undefined,
  toward: ScenePoint,
): ScenePoint {
  if (anchor !== undefined) return anchor
  if (side !== undefined) return sidePoint(rect, side)
  return facing(rect, toward)
}

/** The two ends as the anchor pass resolved them, in the shape this needs. */
export interface BendRouteEnds {
  readonly from?: ScenePoint
  readonly to?: ScenePoint
  readonly fromSide?: Side
  readonly toSide?: Side
}

/**
 * The path through this edge's bends, or `undefined` when it stores none —
 * the overwhelmingly common case, and the caller's signal to compute one.
 */
export function bendRoute(
  edge: CanvasEdge,
  fromRect: Rect,
  toRect: Rect,
  ends: BendRouteEnds,
): readonly ScenePoint[] | undefined {
  const bends = edge.bends
  const first = bends?.[0]
  const last = bends?.[bends.length - 1]
  if (bends === undefined || first === undefined || last === undefined) return undefined
  // `layoutSpatialCanvas` accepts a canvas nobody parsed, and this package
  // never throws on one: a non-finite coordinate reaches `formatCoord`,
  // which does. Half a path is worse than the computed one, so a list with
  // any such point declines wholesale.
  if (!bends.every((bend) => Number.isFinite(bend.x) && Number.isFinite(bend.y))) return undefined
  return [
    endpoint(fromRect, ends.from, ends.fromSide, first),
    ...bends,
    endpoint(toRect, ends.to, ends.toSide, last),
  ]
}
