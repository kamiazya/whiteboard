/** An axis-aligned box in canvas coordinates: a node, a frame, an anchor's rect. */
interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * Whether all four of `rect`'s coordinates are finite — the one test of a box
 * that layout, alignment, snapping and the minimap accept before doing
 * arithmetic on it, so a NaN or infinite box never becomes a NaN transform.
 */
export function isFiniteRect(rect: Rect): boolean {
  return (
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height)
  )
}

/**
 * The smallest axis-aligned box covering every one of `rects`, or
 * `undefined` for an empty list — nothing has no bounds, and an infinite or
 * zero box would read as a real place.
 *
 * A loop rather than `Math.min(...xs)`: spreading a large selection into
 * call arguments overflows the stack.
 */
export function boundsOf(rects: readonly Rect[]): Rect | undefined {
  if (rects.length === 0) return undefined
  let left = Number.POSITIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (const rect of rects) {
    left = Math.min(left, rect.x)
    top = Math.min(top, rect.y)
    right = Math.max(right, rect.x + rect.width)
    bottom = Math.max(bottom, rect.y + rect.height)
  }
  return { x: left, y: top, width: right - left, height: bottom - top }
}
