/**
 * The polyline geometry every instrument in this package reads a drawing
 * with: ink inside a box, corners, length, proper crossings, a path that
 * turns back on an axis, and two paths sharing a line. One definition,
 * used by the drawing score and by the scoreboards' oracles
 * (`test-utils/routing-metrics.ts`, `test-utils/reversal-count.ts`), so
 * that "a crossing" means one thing across every reading.
 *
 * What it must never be used by is the thing those instruments judge. An
 * oracle that shared a primitive with the router would agree with the
 * router's mistakes by construction — the whole reason the oracles exist
 * is to disagree — so nothing under `layout/` imports this module, and
 * `polyline-geometry.independence.test.ts` fails the first import that
 * does. The router keeps its own `edge-geometry.ts`, `edge-rules.ts`'s
 * `interiorInkThrough` and the crossing sweep; the duplication between
 * those and this file is the independence, not an oversight.
 */

export type Point = { readonly x: number; readonly y: number }
export type Rect = {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export const segmentLength = (a: Point, b: Point): number => Math.hypot(b.x - a.x, b.y - a.y)

/** Parameters of the part of `a`→`b` strictly inside `rect`, if any (Liang–Barsky). */
function clipOpen(a: Point, b: Point, rect: Rect): [number, number] | undefined {
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

/**
 * Length of `path` running strictly INSIDE `rect` — the harm of a line that
 * crosses a box's content instead of going around it. A segment lying
 * exactly along a border contributes nothing.
 */
export function interiorInk(path: readonly Point[], rect: Rect): number {
  let total = 0
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] as Point
    const b = path[i] as Point
    const clip = clipOpen(a, b, rect)
    if (clip !== undefined) total += (clip[1] - clip[0]) * segmentLength(a, b)
  }
  return total
}

/** Corners: direction changes along the polyline. */
export function bends(path: readonly Point[]): number {
  let count = 0
  for (let i = 2; i < path.length; i++) {
    const a = path[i - 2] as Point
    const b = path[i - 1] as Point
    const c = path[i] as Point
    if ((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) !== 0) count++
  }
  return count
}

export function pathLength(path: readonly Point[]): number {
  let total = 0
  for (let i = 1; i < path.length; i++) {
    total += segmentLength(path[i - 1] as Point, path[i] as Point)
  }
  return total
}

/** True when `a`→`b` and `c`→`d` meet at a point interior to both. */
function properlyCross(a: Point, b: Point, c: Point, d: Point): boolean {
  const orient = (p: Point, q: Point, r: Point) =>
    Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x))
  const d1 = orient(a, b, c)
  const d2 = orient(a, b, d)
  const d3 = orient(c, d, a)
  const d4 = orient(c, d, b)
  // All four strict: a touch at an endpoint or a shared corner is not a
  // crossing, and collinear overlap is a different defect (`sharedInk`).
  return d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0 && d1 !== d2 && d3 !== d4
}

/** Places two different paths visibly cross each other. */
export function crossings(paths: readonly (readonly Point[])[]): number {
  let count = 0
  for (let i = 0; i < paths.length; i++) {
    for (let j = i + 1; j < paths.length; j++) {
      const p = paths[i] as readonly Point[]
      const q = paths[j] as readonly Point[]
      for (let a = 1; a < p.length; a++) {
        for (let b = 1; b < q.length; b++) {
          if (properlyCross(p[a - 1] as Point, p[a] as Point, q[b - 1] as Point, q[b] as Point))
            count++
        }
      }
    }
  }
  return count
}

/**
 * Direction reversals per axis: a step whose sign on an axis is opposite
 * to the last non-zero sign on that same axis. Compares RAW coordinates,
 * so a caller feeding it geometry that is elsewhere quantized has to say
 * the two agree (`reversal-count.ts`'s `assertQuantumSeparated`).
 */
export function reversals(path: readonly Point[]): number {
  let count = 0
  let lastX = 0
  let lastY = 0
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] as Point
    const b = path[i] as Point
    const sx = Math.sign(b.x - a.x)
    const sy = Math.sign(b.y - a.y)
    if (sx !== 0) {
      if (sx === -lastX) count++
      lastX = sx
    }
    if (sy !== 0) {
      if (sy === -lastY) count++
      lastY = sy
    }
  }
  return count
}

/**
 * Length along which `p` and `q` run on one line, over every pair of their
 * segments. A segment lying on another's line but beyond its ends, or
 * meeting it at a point, shares nothing.
 */
export function sharedInk(p: readonly Point[], q: readonly Point[]): number {
  const cross = (a: Point, b: Point, c: Point) =>
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
  let total = 0
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1] as Point
    const b = p[i] as Point
    const len = segmentLength(a, b)
    if (len === 0) continue
    for (let j = 1; j < q.length; j++) {
      const c = q[j - 1] as Point
      const d = q[j] as Point
      if (cross(a, b, c) !== 0 || cross(a, b, d) !== 0) continue
      const along = (r: Point) =>
        ((r.x - a.x) * (b.x - a.x) + (r.y - a.y) * (b.y - a.y)) / (len * len)
      const lo = Math.max(0, Math.min(along(c), along(d)))
      const hi = Math.min(1, Math.max(along(c), along(d)))
      if (hi > lo) total += (hi - lo) * len
    }
  }
  return total
}
