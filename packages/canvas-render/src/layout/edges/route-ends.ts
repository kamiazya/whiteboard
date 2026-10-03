/**
 * The vocabulary `edge-router.ts` hands its two path builders: where a route
 * starts and ends, and what it steers around. Records rather than positional
 * parameters, because the pairs are the same type and a swapped pair
 * (`fromRect`/`toRect`, `inflated`/`raw`) type-checks and routes wrongly.
 */

import type { EdgeSide } from '@kamiazya/whiteboard-model'
import type { Point, Rect } from './edge-geometry.js'

/**
 * One end of a route: the side it leaves from, the rect it leaves, and how
 * far its stub reaches. The three travel together because they describe the
 * same end; as separate positional parameters a `fromRect` passed for a
 * `toRect` type-checked.
 */
interface RouteEnd {
  readonly side: EdgeSide
  readonly rect: Rect
  readonly depth: number
}

/** Both anchors of a route and what each hangs on. */
export interface RouteEnds {
  readonly start: Point
  readonly end: Point
  readonly from: RouteEnd
  readonly to: RouteEnd
}

/** What a route steers around: the margin-inflated rects and the raw ones they came from. */
export interface RouteObstacles {
  readonly inflated: readonly Rect[]
  readonly raw: readonly Rect[]
}
