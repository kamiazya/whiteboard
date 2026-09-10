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
} from '../quality/polyline-geometry.js'

export type { MetricPoint, MetricRect }
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
