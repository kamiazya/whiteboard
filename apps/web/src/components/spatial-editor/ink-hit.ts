/**
 * Which drawn path a press landed on, when ink and a node are both under it.
 *
 * Ink is drawn ON what it crosses — a stroke over a note is on top of the
 * note, the way it would be on paper — so a press on the stroke selects the
 * stroke. Without this the node wins at the first branch, the line hit-test
 * never runs, and ink over ANY content cannot be selected and therefore
 * cannot be deleted except by undo. On a board with something on it, that is
 * most of the ink.
 *
 * Scoped to LINES on purpose. An edge is a relation whose path is ROUTED,
 * and routing already steers it around the boxes it connects; letting an edge
 * win over a node it happens to pass over would lay a dead band across a node
 * somebody is trying to press, in exchange for a case the router avoids.
 */
import { distanceToPolyline } from '../../lib/spatial/geometry.js'
import type { Point } from '../../lib/spatial/viewport.js'

export interface DrawnPath {
  readonly id: string
  /** The path as DRAWN — the flattened one the highlight also uses. */
  readonly path: readonly Point[]
  /** True for a line (ink). Absent for an edge. */
  readonly ink?: boolean
}

/**
 * The ink under `point`, or `undefined`. `tolerance` is in CANVAS units, so
 * the caller divides its screen-sized budget by the zoom — what counts as
 * "on the stroke" is how near the finger was to it on the display.
 */
export function inkUnder(
  paths: readonly DrawnPath[],
  point: Point,
  tolerance: number,
  isLocked: (id: string) => boolean,
): DrawnPath | undefined {
  return paths.find(
    (entry) =>
      entry.ink === true &&
      !isLocked(entry.id) &&
      distanceToPolyline(point, entry.path) <= tolerance,
  )
}
