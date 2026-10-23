// The line-jump narrow phase on its own, so the broad phase in front of it
// can be measured by counting its calls.
import type { Point } from './edge-geometry.js'

/** Radius of the hop arc, in px. Kept below the editor's edge hit tolerance so the decoration never escapes the grabbable band around the raw path. */
export const EDGE_JUMP_RADIUS_PX = 5

/**
 * A hop needs `radius` of straight run on both sides to land back on the
 * segment; crossings closer than that to a segment end (junctions, corner
 * touches) are not drawn.
 */
export const END_CLEARANCE_PX = EDGE_JUMP_RADIUS_PX + 1

/** Proper interior intersection of segments a1-a2 and b1-b2, or undefined. */
export function segmentIntersection(a1: Point, a2: Point, b1: Point, b2: Point): Point | undefined {
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
  // An extent that overflows turns the arithmetic NaN (0 × ∞), which passes
  // every comparison above; a hop there would write NaN into the path.
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return undefined
  const lenA = Math.hypot(dax, day)
  // Too close to either end of the jumping segment to fit the arc.
  if (t * lenA < END_CLEARANCE_PX || (1 - t) * lenA < END_CLEARANCE_PX) return undefined
  return point
}
