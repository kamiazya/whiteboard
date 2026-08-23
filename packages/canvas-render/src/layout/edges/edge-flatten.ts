// The drawn edge line as a dense polyline — rounded corners AND line-jump
// hops included — for consumers that need points rather than an SVG path
// (the editor's hit-testing and selection highlight). Mirrors the SVG
// backend's emission branch for branch: plain segments hop every jump on
// their segment; rounded paths truncate spans to the corner midpoints and
// drop hops without arc clearance, exactly like `roundedPathData`.
import type { EdgeJumpPoint } from '../../scene-graph.js'
import { EDGE_JUMP_RADIUS_PX } from './edge-jumps.js'
import { flattenRoundedEdgePath, roundedEdgeCorners } from './edge-rounding.js'

type Point = { readonly x: number; readonly y: number }

/** Chord count per hop; matches the corner flattening's sub-pixel budget. */
const HOP_SUBDIVISIONS = 8

/**
 * Where a hop's half-circle meets the base line: entry and exit one jump
 * radius before/after the crossing, along the direction of travel. The
 * ONE producer of hop endpoints — the SVG backend's `A` command and this
 * module's sampling both start and land here.
 */
export function hopEndpoints(
  from: Point,
  to: Point,
  jump: Point,
): { readonly entry: Point; readonly exit: Point } | undefined {
  const len = Math.hypot(to.x - from.x, to.y - from.y)
  if (len === 0) return undefined
  const ux = (to.x - from.x) / len
  const uy = (to.y - from.y) / len
  const r = EDGE_JUMP_RADIUS_PX
  return {
    entry: { x: jump.x - ux * r, y: jump.y - uy * r },
    exit: { x: jump.x + ux * r, y: jump.y + uy * r },
  }
}

/**
 * Sampled half-circle over `jump` on the run `from`->`to`, bulging to the
 * LEFT of travel (the same sweep the backend's `A` command draws),
 * including the entry and exit points on the base line.
 */
function hopPoints(from: Point, to: Point, jump: Point): Point[] {
  const len = Math.hypot(to.x - from.x, to.y - from.y)
  if (len === 0) return []
  const ux = (to.x - from.x) / len
  const uy = (to.y - from.y) / len
  // Left of travel in SVG's y-down coordinates.
  const nx = uy
  const ny = -ux
  const r = EDGE_JUMP_RADIUS_PX
  const points: Point[] = []
  for (let step = 0; step <= HOP_SUBDIVISIONS; step++) {
    const t = step / HOP_SUBDIVISIONS
    points.push({
      x: jump.x - ux * r * Math.cos(Math.PI * t) + nx * r * Math.sin(Math.PI * t),
      y: jump.y - uy * r * Math.cos(Math.PI * t) + ny * r * Math.sin(Math.PI * t),
    })
  }
  return points
}

/** The points after `from` along the run to `to`, hopping each jump. */
function spanPoints(from: Point, to: Point, jumps: readonly Point[]): Point[] {
  const points: Point[] = []
  for (const jump of jumps) points.push(...hopPoints(from, to, jump))
  points.push(to)
  return points
}

/**
 * The jumps on original segment `segment` that fall INSIDE the drawn span
 * `from`->`to` with enough clearance for the arc. A rounded corner
 * truncates its segments to midpoints, so a hop computed near a corner may
 * fall in the curve zone — those are dropped rather than deforming the
 * corner. Shared with the SVG backend so "which hops are drawn" has one
 * producer.
 */
export function jumpsWithinSpan(
  jumps: readonly EdgeJumpPoint[],
  segment: number,
  from: Point,
  to: Point,
): readonly EdgeJumpPoint[] {
  const len = Math.hypot(to.x - from.x, to.y - from.y)
  if (len === 0) return []
  const ux = (to.x - from.x) / len
  const uy = (to.y - from.y) / len
  return jumps.filter((jump) => {
    if (jump.segment !== segment) return false
    const t = (jump.x - from.x) * ux + (jump.y - from.y) * uy
    return t > EDGE_JUMP_RADIUS_PX && t < len - EDGE_JUMP_RADIUS_PX
  })
}

/**
 * The drawn edge as a polyline. `rounded` and `jumps` compose exactly as
 * the backend composes them; with neither, the input path returns as-is.
 */
export function flattenDrawnEdgePath(
  path: readonly Point[],
  jumps: readonly EdgeJumpPoint[] = [],
  rounded = false,
): Point[] {
  if (jumps.length === 0) return rounded ? flattenRoundedEdgePath(path) : [...path]
  const first = path[0]
  const last = path.at(-1)
  if (first === undefined || last === undefined) return [...path]

  if (!rounded || path.length < 3) {
    const points: Point[] = [first]
    const spanJumps = rounded ? jumpsWithinSpan(jumps, 0, first, last) : undefined
    for (let seg = 0; seg < path.length - 1; seg++) {
      const from = path[seg]!
      const to = path[seg + 1]!
      points.push(
        ...spanPoints(from, to, spanJumps ?? jumps.filter((jump) => jump.segment === seg)),
      )
    }
    return points
  }

  const points: Point[] = [first]
  let current: Point = first
  const corners = roundedEdgeCorners(path)
  for (const [index, { enter, control, leave }] of corners.entries()) {
    points.push(...spanPoints(current, enter, jumpsWithinSpan(jumps, index, current, enter)))
    for (let step = 1; step <= HOP_SUBDIVISIONS; step++) {
      const t = step / HOP_SUBDIVISIONS
      const u = 1 - t
      points.push({
        x: u * u * enter.x + 2 * u * t * control.x + t * t * leave.x,
        y: u * u * enter.y + 2 * u * t * control.y + t * t * leave.y,
      })
    }
    current = leave
  }
  points.push(...spanPoints(current, last, jumpsWithinSpan(jumps, corners.length, current, last)))
  return points
}
