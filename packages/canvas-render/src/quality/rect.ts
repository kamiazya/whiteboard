import type { SpatialNode } from '@kamiazya/whiteboard-model'
import type { BoundingBox } from '@kamiazya/whiteboard-scene'

/**
 * The rectangle arithmetic the quality instruments share with each other.
 *
 * Deliberately NOT shared with `layout/`: the router, tidy and the bubble
 * placer keep their own geometry (`layout/edges/edge-geometry.ts`,
 * `tidy-units.ts`), because an instrument that read the code it judges through
 * the same primitive would agree with that code's mistakes by construction —
 * the rule `polyline-geometry.independence.test.ts` pins for the polyline
 * primitives.
 */
export type Rect = BoundingBox

export const rectOf = (n: SpatialNode): Rect => ({ x: n.x, y: n.y, w: n.width, h: n.height })

export const area = (r: Rect): number => r.w * r.h

/** The shared area of two rectangles; touching edges share none. */
export const overlapArea = (a: Rect, b: Rect): number => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

/** Edge-inclusive: a rectangle contains an identical one, and one sharing a border. */
export const contains = (outer: Rect, inner: Rect): boolean =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.w <= outer.x + outer.w &&
  inner.y + inner.h <= outer.y + outer.h

export const round2 = (n: number): number => Math.round(n * 100) / 100
