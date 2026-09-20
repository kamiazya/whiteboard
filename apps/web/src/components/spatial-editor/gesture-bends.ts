/**
 * The bend gesture's own half of the reducer: what a bend drag remembers,
 * what its three events do, and what any of them writes.
 *
 * Its own module because the cluster shares nothing with the rest of the
 * machine — no node lookup, no text-edit interaction, no selection — and
 * because `gestures.ts` crossed the 800-line budget when ink joined it. A
 * reducer arm here is `reduceGesture`'s to dispatch and this file's to
 * decide, which is the same split `layout/` uses for two engines that never
 * call each other.
 */

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { EditorCommand } from '../../lib/spatial/commands.js'
import { bendInkCommand } from '../../lib/spatial/commands.js'
import type { Point } from '../../lib/spatial/viewport.js'
import { routableElement } from './gesture-ends.js'

/**
 * A bend being dragged on one element.
 *
 * `waypoints` is the list the gesture ENDS with, minus the drag — the
 * overlay hands it over already carrying a point the element does not have
 * when a ghost handle on a straight run is what was pressed, so adding a
 * bend and moving one are the same gesture and this machine knows only the
 * second. Whether a point is worth inserting is geometry the overlay has
 * and the reducer does not.
 */
export interface BendSnapshot {
  readonly kind: 'bending'
  readonly edgeId: string
  readonly index: number
  readonly startPoint: Point
  readonly waypoints: readonly Point[]
}

/**
 * The points the element STORES, whichever collection it is in. The scene
 * hands an edge and a line out identically, so the id the bend affordance
 * carries could be either — and reading `canvas.edges` alone answered an
 * empty list for every stroke, which reads as "this has no bends" rather
 * than as "I looked in one place".
 */
export function storedWaypoints(canvas: SpatialCanvas, id: string): readonly Point[] {
  return routableElement(canvas, id)?.bends ?? []
}

/** Whether this id still names something with bends — the drag's target check. */
export function bendTargetExists(canvas: SpatialCanvas, id: string): boolean {
  return routableElement(canvas, id) !== undefined
}

/**
 * The bend list an element should carry. An empty list clears the field,
 * since one storing no bends takes a computed route again — and the model
 * refuses an empty array for exactly that reason: absence already says it.
 *
 * `bendInkCommand` is the one place that looks at which collection the id
 * came from; an id in neither answers nothing rather than a write aimed at
 * a guess.
 */
export function bendCommands(
  canvas: SpatialCanvas,
  id: string,
  waypoints: readonly Point[],
): readonly EditorCommand[] {
  const command = bendInkCommand(canvas, id, [...waypoints])
  return command === undefined ? [] : [command]
}

/**
 * Whole units, the way a node position is rounded. The MODEL accepts a
 * fraction since ADR-0037 slice 4, so this is a UI decision rather than a
 * schema one: a point somebody dragged to is a point they can find again,
 * and 137.4183 is not. Ink reaches this drag too, and takes the same
 * rounding — a stroke's own points keep whatever the pen reported, and a
 * bend somebody placed by hand is placed here.
 */
export function movedWaypoints(
  waypoints: readonly Point[],
  index: number,
  dx: number,
  dy: number,
): readonly Point[] {
  return waypoints.map((point, at) =>
    at === index ? { x: Math.round(point.x + dx), y: Math.round(point.y + dy) } : point,
  )
}
