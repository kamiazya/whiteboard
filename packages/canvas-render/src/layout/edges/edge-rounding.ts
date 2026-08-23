// The single definition of how a rounded edge's corners are shaped. The SVG
// backend serializes these corners as quadratic Béziers; the editor flattens
// the same corners for hit-testing and the selection highlight. Sharing the
// decomposition is what keeps "where the ink is" and "where a tap lands" the
// same curve.

type Point = { readonly x: number; readonly y: number }

export type RoundedEdgeCorner = {
  /** Midpoint of the incoming segment — where the curve departs the polyline. */
  readonly enter: Point
  /** The original corner vertex, used as the quadratic control point. */
  readonly control: Point
  /** Midpoint of the outgoing segment — where the curve rejoins the polyline. */
  readonly leave: Point
}

const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })

/**
 * Each interior vertex becomes a quadratic whose endpoints are the midpoints
 * of the two segments meeting there. A quadratic never leaves the triangle of
 * its three points, so the curve stays inside the polyline's bounds —
 * sceneBounds/translateScene/scaleScene stay correct working on the waypoints
 * alone. Fewer than three points means nothing to round.
 */
export function roundedEdgeCorners(path: readonly Point[]): RoundedEdgeCorner[] {
  return path.slice(1, -1).map((corner, i) => ({
    enter: midpoint(path[i] as Point, corner),
    control: corner,
    leave: midpoint(corner, path[i + 2] as Point),
  }))
}

/** Chord count per corner; at typical corner sizes the chords sit well under a pixel from the true curve. */
const CORNER_SUBDIVISIONS = 8

/**
 * The rounded edge as a dense polyline following the drawn curve — for
 * consumers that need points rather than an SVG path (hit-testing, selection
 * highlight). Endpoints are preserved; a path too short to round comes back
 * unchanged.
 */
export function flattenRoundedEdgePath(path: readonly Point[]): Point[] {
  const first = path[0]
  const last = path.at(-1)
  const corners = roundedEdgeCorners(path)
  if (first === undefined || last === undefined || corners.length === 0) return [...path]

  const points: Point[] = [first]
  for (const { enter, control, leave } of corners) {
    for (let step = 0; step <= CORNER_SUBDIVISIONS; step++) {
      const t = step / CORNER_SUBDIVISIONS
      const u = 1 - t
      points.push({
        x: u * u * enter.x + 2 * u * t * control.x + t * t * leave.x,
        y: u * u * enter.y + 2 * u * t * control.y + t * t * leave.y,
      })
    }
  }
  points.push(last)
  return points
}
