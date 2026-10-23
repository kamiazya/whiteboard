/**
 * Independent geometric oracle for routing quality. Deliberately never calls
 * `edge-rules.ts` or any other production scorer, so a test asserting against
 * it cannot be satisfied by a broken rule agreeing with itself — the same
 * contract `reversal-count.ts` holds for the `path-reversal` rule. The
 * polyline primitives come from `quality/polyline-geometry.ts`, shared with
 * the drawing score and guarded against any import from `layout/`, so the
 * contract holds there too.
 *
 * Where the penalty rules answer "which candidate wins", these answer "how
 * good is the drawing", in units a reader can check against a picture:
 * pixels of ink in the wrong place, and counts of the shapes that make a
 * diagram hard to read.
 */

import {
  bends,
  crossings,
  interiorInk,
  type Point as MetricPoint,
  type Rect as MetricRect,
  pathLength,
  segmentLength,
  sharedInk,
} from '../quality/polyline-geometry.js'

export type { MetricPoint, MetricRect }

type Point = MetricPoint

export { bends, crossings, interiorInk, pathLength }

/**
 * Length of `path` lying ON one of `rect`'s four borders — a stroke drawn
 * over a stroke. Milder than `interiorInk` (it hides an existing line rather
 * than crossing content), and the two are complements: no length is counted
 * by both.
 */
export function borderInk(path: readonly MetricPoint[], rect: MetricRect): number {
  const right = rect.x + rect.w
  const bottom = rect.y + rect.h
  let total = 0
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] as MetricPoint
    const b = path[i] as MetricPoint
    if (a.y === b.y && (a.y === rect.y || a.y === bottom)) {
      const lo = Math.max(Math.min(a.x, b.x), rect.x)
      const hi = Math.min(Math.max(a.x, b.x), right)
      if (hi > lo) total += hi - lo
    }
    if (a.x === b.x && (a.x === rect.x || a.x === right)) {
      const lo = Math.max(Math.min(a.y, b.y), rect.y)
      const hi = Math.min(Math.max(a.y, b.y), bottom)
      if (hi > lo) total += hi - lo
    }
  }
  return total
}

/**
 * The arrowhead is drawn ON the final segment and is `ARROW_LENGTH` long, so
 * a shorter final segment paints an arrow with no line under it — it reads as
 * a marker stuck to the box rather than an edge arriving at it. Reported as a
 * length so a caller can decide its own floor.
 */
export function finalSegmentLength(path: readonly MetricPoint[]): number {
  const end = path[path.length - 1]
  const before = path[path.length - 2]
  return end === undefined || before === undefined ? 0 : segmentLength(before, end)
}

/** Total drawn length. Zero means the edge is INVISIBLE — nothing is painted
 * and no arrowhead can be oriented, so a reader cannot tell the edge exists. */
export function drawnLength(path: readonly MetricPoint[]): number {
  return pathLength(path)
}

/** True when `a`→`b` and `c`→`d` meet at a point interior to both. */
function properlyCross(a: Point, b: Point, c: Point, d: Point): boolean {
  const orient = (p: Point, q: Point, r: Point) =>
    Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x))
  const d1 = orient(a, b, c)
  const d2 = orient(a, b, d)
  const d3 = orient(c, d, a)
  const d4 = orient(c, d, b)
  return d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0 && d1 !== d2 && d3 !== d4
}

/** The path with every point on a straight run between its neighbours dropped. */
function runsOf(path: readonly Point[]): Point[] {
  return path.filter((point, i) => {
    const prev = path[i - 1]
    const next = path[i + 1]
    if (prev === undefined || next === undefined) return true
    const turn = (point.x - prev.x) * (next.y - point.y) - (point.y - prev.y) * (next.x - point.x)
    const ahead = (point.x - prev.x) * (next.x - point.x) + (point.y - prev.y) * (next.y - point.y)
    return turn !== 0 || ahead <= 0
  })
}

/** Where `p`'s and `q`'s straight runs properly cross, one point per crossing. */
function runCrossingPoints(p: readonly Point[], q: readonly Point[]): Point[] {
  const found: Point[] = []
  for (let a = 1; a < p.length; a++) {
    for (let b = 1; b < q.length; b++) {
      const a1 = p[a - 1] as Point
      const a2 = p[a] as Point
      const b1 = q[b - 1] as Point
      const b2 = q[b] as Point
      if (!properlyCross(a1, a2, b1, b2)) continue
      const denom = (a2.x - a1.x) * (b2.y - b1.y) - (a2.y - a1.y) * (b2.x - b1.x)
      const t = ((b1.x - a1.x) * (b2.y - b1.y) - (b1.y - a1.y) * (b2.x - b1.x)) / denom
      found.push({ x: a1.x + t * (a2.x - a1.x), y: a1.y + t * (a2.y - a1.y) })
    }
  }
  return found
}

/**
 * Crossings between two paths' straight RUNS that draw no hop: a waypoint on a
 * straight run is bookkeeping, not a corner, so a crossing that lands on one
 * is still a crossing. `hops[k]` are the points where path `k` was drawn
 * hopping; a crossing is hopped when either path hops within half a pixel of
 * it (the arc may sit on whichever line has room for it).
 */
export function unhoppedCrossings(
  paths: readonly (readonly Point[])[],
  hops: readonly (readonly Point[])[],
): number {
  let count = 0
  const runs = paths.map(runsOf)
  for (let i = 0; i < runs.length; i++) {
    for (let j = i + 1; j < runs.length; j++) {
      const p = runs[i] as readonly Point[]
      const q = runs[j] as readonly Point[]
      if (boundsApart(p, q)) continue
      const hopped = (at: Point) =>
        [...(hops[i] ?? []), ...(hops[j] ?? [])].some(
          (h) => Math.hypot(h.x - at.x, h.y - at.y) <= 0.5,
        )
      count += runCrossingPoints(p, q).filter((at) => !hopped(at)).length
    }
  }
  return count
}

/** Whether two paths' bounding boxes miss each other, so no segment pair can meet. */
function boundsApart(p: readonly Point[], q: readonly Point[]): boolean {
  const span = (path: readonly Point[]) => ({
    minX: Math.min(...path.map((v) => v.x)),
    maxX: Math.max(...path.map((v) => v.x)),
    minY: Math.min(...path.map((v) => v.y)),
    maxY: Math.max(...path.map((v) => v.y)),
  })
  const a = span(p)
  const b = span(q)
  return a.maxX < b.minX || b.maxX < a.minX || a.maxY < b.minY || b.maxY < a.minY
}

/** Whether `p` lies on the closed segment `a`→`b`. */
function onSegment(p: Point, a: Point, b: Point): boolean {
  if ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) !== 0) return false
  return (
    p.x >= Math.min(a.x, b.x) &&
    p.x <= Math.max(a.x, b.x) &&
    p.y >= Math.min(a.y, b.y) &&
    p.y <= Math.max(a.y, b.y)
  )
}

/**
 * Points where two different paths TOUCH without crossing and where neither
 * path begins or ends: a corner meeting a corner, or a corner resting on the
 * other's run. A reader sees a crossing (or a junction) there, yet no hop can
 * be drawn at a corner and no proper-crossing count includes it, so it is the
 * crossing that escapes both. Paths converging on one anchor end at that
 * point and are not counted; a stretch where they run on one line is
 * `sharedInk`'s, not this.
 */
export function touches(paths: readonly (readonly Point[])[]): number {
  let count = 0
  for (let i = 0; i < paths.length; i++) {
    for (let j = i + 1; j < paths.length; j++) {
      const p = paths[i] as readonly Point[]
      const q = paths[j] as readonly Point[]
      if (!boundsApart(p, q)) count += touchPoints(p, q).size
    }
  }
  return count
}

/** The distinct points where `p` and `q` touch without either path ending there. */
function touchPoints(p: readonly Point[], q: readonly Point[]): Set<string> {
  const ends = [p[0], p[p.length - 1], q[0], q[q.length - 1]]
  const seen = new Set<string>()
  for (let a = 1; a < p.length; a++) {
    for (let b = 1; b < q.length; b++) {
      const a1 = p[a - 1] as Point
      const a2 = p[a] as Point
      const b1 = q[b - 1] as Point
      const b2 = q[b] as Point
      if (sharedInk([a1, a2], [b1, b2]) > 0) continue
      const candidates = [
        ...[b1, b2].filter((c) => onSegment(c, a1, a2)),
        ...[a1, a2].filter((c) => onSegment(c, b1, b2)),
      ]
      for (const c of candidates) {
        if (!ends.some((e) => e !== undefined && e.x === c.x && e.y === c.y))
          seen.add(`${c.x},${c.y}`)
      }
    }
  }
  return seen
}
