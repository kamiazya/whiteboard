// Line-jump computation: where one routed edge crosses another, the LATER
// edge in document order (the one painted on top) receives a hop point.
// Pure segment-pair intersection over already-routed polylines — no
// knowledge of styles; rounded corners re-use the same points because
// 'curved' travels the orthogonal waypoints.
import type { EdgeJumpPoint, ResolvedEdgeNode } from '@kamiazya/whiteboard-scene'

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
interface Crossing {
  readonly point: Point
  /** Where along the jumping segment it falls, 0 at `a1` and 1 at `a2`. */
  readonly t: number
}

/** Every proper crossing of segment `a1`-`a2` by any segment of `earlier`. */
function crossingsOn(a1: Point, a2: Point, earlier: readonly ResolvedEdgeNode[]): Crossing[] {
  const len = Math.hypot(a2.x - a1.x, a2.y - a1.y)
  const found: Crossing[] = []
  for (const edge of earlier) {
    for (let k = 0; k < edge.path.length - 1; k += 1) {
      const hit = segmentIntersection(a1, a2, edge.path[k] as Point, edge.path[k + 1] as Point)
      if (hit === undefined) continue
      found.push({ point: hit, t: len === 0 ? 0 : Math.hypot(hit.x - a1.x, hit.y - a1.y) / len })
    }
  }
  return found
}

/**
 * The crossings that can each carry their own arc, in order along the
 * segment.
 *
 * Hops closer than a diameter cannot fit as separate arcs — the first arc's
 * exit would sit past the next arc's entry and the path would double back.
 * The first crossing keeps its hop.
 */
function spacedHops(crossings: Crossing[], segLen: number, seg: number): EdgeJumpPoint[] {
  crossings.sort((p, q) => p.t - q.t)
  const kept: EdgeJumpPoint[] = []
  let lastKeptT = Number.NEGATIVE_INFINITY
  for (const { point, t } of crossings) {
    if ((t - lastKeptT) * segLen < 2 * EDGE_JUMP_RADIUS_PX) continue
    lastKeptT = t
    kept.push({ segment: seg, x: point.x, y: point.y })
  }
  return kept
}

export function computeEdgeJumps(
  edges: readonly ResolvedEdgeNode[],
): ReadonlyMap<string, readonly EdgeJumpPoint[]> {
  const result = new Map<string, readonly EdgeJumpPoint[]>()
  for (let i = 1; i < edges.length; i += 1) {
    const later = edges[i] as ResolvedEdgeNode
    const earlier = edges.slice(0, i)
    const jumps: EdgeJumpPoint[] = []
    for (let seg = 0; seg < later.path.length - 1; seg += 1) {
      const a1 = later.path[seg] as Point
      const a2 = later.path[seg + 1] as Point
      const segLen = Math.hypot(a2.x - a1.x, a2.y - a1.y)
      jumps.push(...spacedHops(crossingsOn(a1, a2, earlier), segLen, seg))
    }
    if (jumps.length > 0) result.set(later.id, jumps)
  }
  return result
}
