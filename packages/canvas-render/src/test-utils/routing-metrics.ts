/**
 * Independent geometric oracle for routing quality. Deliberately never calls
 * `edge-rules.ts` or any other production scorer, so a test asserting against
 * it cannot be satisfied by a broken rule agreeing with itself — the same
 * contract `reversal-count.ts` holds for the `path-reversal` rule.
 *
 * Where the penalty rules answer "which candidate wins", these answer "how
 * good is the drawing", in units a reader can check against a picture:
 * pixels of ink in the wrong place, and counts of the shapes that make a
 * diagram hard to read.
 */

export type MetricRect = { x: number; y: number; w: number; h: number }
export type MetricPoint = { x: number; y: number }

/** Clip parameters of the part of `a`→`b` strictly inside `rect`, if any. */
function clipOpen(a: MetricPoint, b: MetricPoint, rect: MetricRect): [number, number] | undefined {
  const dx = b.x - a.x
  const dy = b.y - a.y
  let t0 = 0
  let t1 = 1
  const slabs: readonly [number, number][] = [
    [-dx, a.x - rect.x],
    [dx, rect.x + rect.w - a.x],
    [-dy, a.y - rect.y],
    [dy, rect.y + rect.h - a.y],
  ]
  for (const [p, q] of slabs) {
    if (p === 0) {
      // Parallel to this slab. `q > 0` is strictly within it; `q === 0` puts
      // the whole segment ON the boundary, which is border ink, not interior.
      if (q <= 0) return undefined
      continue
    }
    const t = q / p
    if (p < 0) {
      if (t > t1) return undefined
      if (t > t0) t0 = t
    } else {
      if (t < t0) return undefined
      if (t < t1) t1 = t
    }
  }
  return t1 > t0 ? [t0, t1] : undefined
}

const segmentLength = (a: MetricPoint, b: MetricPoint) => Math.hypot(b.x - a.x, b.y - a.y)

/**
 * Length of `path` running strictly INSIDE `rect` — the harm of a line that
 * crosses a node's content instead of going around it. A segment lying
 * exactly along a border contributes nothing here; that is `borderInk`.
 */
export function interiorInk(path: readonly MetricPoint[], rect: MetricRect): number {
  let total = 0
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] as MetricPoint
    const b = path[i] as MetricPoint
    const clip = clipOpen(a, b, rect)
    if (clip !== undefined) total += (clip[1] - clip[0]) * segmentLength(a, b)
  }
  return total
}

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

/** Corners: direction changes along the polyline. */
export function bends(path: readonly MetricPoint[]): number {
  let count = 0
  for (let i = 2; i < path.length; i++) {
    const a = path[i - 2] as MetricPoint
    const b = path[i - 1] as MetricPoint
    const c = path[i] as MetricPoint
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
    if (cross !== 0) count++
  }
  return count
}

export function pathLength(path: readonly MetricPoint[]): number {
  let total = 0
  for (let i = 1; i < path.length; i++) {
    total += segmentLength(path[i - 1] as MetricPoint, path[i] as MetricPoint)
  }
  return total
}

/** True when `a`→`b` and `c`→`d` meet at a point interior to both. */
function segmentsProperlyCross(
  a: MetricPoint,
  b: MetricPoint,
  c: MetricPoint,
  d: MetricPoint,
): boolean {
  const orient = (p: MetricPoint, q: MetricPoint, r: MetricPoint) =>
    Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x))
  const d1 = orient(a, b, c)
  const d2 = orient(a, b, d)
  const d3 = orient(c, d, a)
  const d4 = orient(c, d, b)
  // All four strict: a touch at an endpoint or a shared corner is not a
  // crossing, and collinear overlap is a different defect (border tracing).
  return d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0 && d1 !== d2 && d3 !== d4
}

/** Places two different paths visibly cross each other. */
export function crossings(paths: readonly (readonly MetricPoint[])[]): number {
  let count = 0
  for (let i = 0; i < paths.length; i++) {
    for (let j = i + 1; j < paths.length; j++) {
      const p = paths[i] as readonly MetricPoint[]
      const q = paths[j] as readonly MetricPoint[]
      for (let a = 1; a < p.length; a++) {
        for (let b = 1; b < q.length; b++) {
          if (
            segmentsProperlyCross(
              p[a - 1] as MetricPoint,
              p[a] as MetricPoint,
              q[b - 1] as MetricPoint,
              q[b] as MetricPoint,
            )
          ) {
            count++
          }
        }
      }
    }
  }
  return count
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
