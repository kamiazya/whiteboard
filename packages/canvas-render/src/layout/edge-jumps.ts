// Line-jump computation: where one routed edge crosses another, the LATER
// edge in document order (the one painted on top) receives a hop point.
// Pure segment-pair intersection over already-routed polylines — no
// knowledge of styles; rounded corners re-use the same points because
// 'curved' travels the orthogonal waypoints.
import type { EdgeJumpPoint, ResolvedEdgeNode } from '../scene-graph.js'

type Point = { readonly x: number; readonly y: number }

/** Radius of the hop arc, in px. Kept below the editor's edge hit tolerance so the decoration never escapes the grabbable band around the raw path. */
export const EDGE_JUMP_RADIUS_PX = 5

/**
 * A hop needs `radius` of straight run on both sides to land back on the
 * segment; crossings closer than that to a segment end (junctions, corner
 * touches) are not drawn.
 */
const END_CLEARANCE_PX = EDGE_JUMP_RADIUS_PX + 1

/** Proper interior intersection of segments a1-a2 and b1-b2, or undefined. */
function segmentIntersection(a1: Point, a2: Point, b1: Point, b2: Point): Point | undefined {
  const dax = a2.x - a1.x
  const day = a2.y - a1.y
  const dbx = b2.x - b1.x
  const dby = b2.y - b1.y
  const denom = dax * dby - day * dbx
  if (denom === 0) return undefined // parallel or degenerate — nothing to hop
  const t = ((b1.x - a1.x) * dby - (b1.y - a1.y) * dbx) / denom
  const u = ((b1.x - a1.x) * day - (b1.y - a1.y) * dax) / denom
  if (t <= 0 || t >= 1 || u <= 0 || u >= 1) return undefined
  const point = { x: a1.x + t * dax, y: a1.y + t * day }
  const lenA = Math.hypot(dax, day)
  // Too close to either end of the jumping segment to fit the arc.
  if (t * lenA < END_CLEARANCE_PX || (1 - t) * lenA < END_CLEARANCE_PX) return undefined
  return point
}

/**
 * Hop points for each edge over every EARLIER edge, keyed by edge id.
 * Later-over-earlier mirrors paint order: the line drawn on top is the one
 * that visibly hops. Jumps on one segment are ordered along its direction.
 */
export function computeEdgeJumps(
  edges: readonly ResolvedEdgeNode[],
): ReadonlyMap<string, readonly EdgeJumpPoint[]> {
  const result = new Map<string, readonly EdgeJumpPoint[]>()
  for (let i = 1; i < edges.length; i += 1) {
    const later = edges[i] as ResolvedEdgeNode
    const jumps: EdgeJumpPoint[] = []
    for (let seg = 0; seg < later.path.length - 1; seg += 1) {
      const a1 = later.path[seg] as Point
      const a2 = later.path[seg + 1] as Point
      const onSegment: { point: Point; t: number }[] = []
      for (let j = 0; j < i; j += 1) {
        const earlier = edges[j] as ResolvedEdgeNode
        for (let k = 0; k < earlier.path.length - 1; k += 1) {
          const hit = segmentIntersection(
            a1,
            a2,
            earlier.path[k] as Point,
            earlier.path[k + 1] as Point,
          )
          if (hit !== undefined) {
            const len = Math.hypot(a2.x - a1.x, a2.y - a1.y)
            const t = len === 0 ? 0 : Math.hypot(hit.x - a1.x, hit.y - a1.y) / len
            onSegment.push({ point: hit, t })
          }
        }
      }
      onSegment.sort((p, q) => p.t - q.t)
      for (const { point } of onSegment) {
        jumps.push({ segment: seg, x: point.x, y: point.y })
      }
    }
    if (jumps.length > 0) result.set(later.id, jumps)
  }
  return result
}
