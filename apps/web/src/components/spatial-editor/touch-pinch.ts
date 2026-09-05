import type { Point } from '../../lib/spatial/viewport.js'

/**
 * Pure math for the two-finger touch gesture: given the previous and next
 * root-local positions of both fingers, produce the viewport update — pan
 * by the centroid's movement, zoom by the finger-distance ratio, anchored
 * at the next centroid so the content under the fingers stays under them.
 *
 * The caller applies it as `zoomAt(panBy(vp, panDelta), anchor, zoomFactor)`
 * (pan first, then zoom around the post-pan anchor).
 */
export interface PinchPair {
  readonly a: Point
  readonly b: Point
}

export interface PinchUpdate {
  readonly panDelta: Point
  readonly zoomFactor: number
  readonly anchor: Point
}

// Below this finger distance (px) the ratio becomes numerically wild —
// treat the pinch as pan-only for that frame.
const MIN_PINCH_DISTANCE_PX = 1

function centroid(pair: PinchPair): Point {
  return { x: (pair.a.x + pair.b.x) / 2, y: (pair.a.y + pair.b.y) / 2 }
}

function distance(pair: PinchPair): number {
  return Math.hypot(pair.a.x - pair.b.x, pair.a.y - pair.b.y)
}

export function computePinchUpdate(prev: PinchPair, next: PinchPair): PinchUpdate {
  const prevCentroid = centroid(prev)
  const nextCentroid = centroid(next)
  const prevDistance = distance(prev)
  const nextDistance = distance(next)
  const zoomFactor =
    prevDistance < MIN_PINCH_DISTANCE_PX || nextDistance < MIN_PINCH_DISTANCE_PX
      ? 1
      : nextDistance / prevDistance
  return {
    panDelta: { x: nextCentroid.x - prevCentroid.x, y: nextCentroid.y - prevCentroid.y },
    zoomFactor,
    anchor: nextCentroid,
  }
}
