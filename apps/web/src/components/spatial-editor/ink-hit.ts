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

export interface Rect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

const inside = (p: Point, r: Rect) =>
  p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h

/** Whether the segments `a`-`b` and `c`-`d` cross. */
function segmentsCross(a: Point, b: Point, c: Point, d: Point): boolean {
  const side = (p: Point, q: Point, r: Point) =>
    Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x))
  const d1 = side(a, b, c)
  const d2 = side(a, b, d)
  const d3 = side(c, d, a)
  const d4 = side(c, d, b)
  // Collinear-overlapping cases are deliberately not special-cased: a stroke
  // running exactly along a band's edge is caught by its endpoints or by the
  // neighbouring edge, and treating the degenerate case as a miss keeps this
  // a predicate rather than a case analysis.
  return d1 !== d2 && d3 !== d4
}

/**
 * Ink the band TOUCHES — any part of the drawn path inside it, not only a
 * stroke wholly contained.
 *
 * Touch rather than containment because of what the gesture is for: a
 * scribble is several strokes that wander, and a band a person drags over
 * "that mess there" is aiming at what it covers. Demanding containment would
 * make the common case — a stroke running off the side of the band — silently
 * survive a delete that looked like it took everything.
 */
export function inkWithin(
  paths: readonly DrawnPath[],
  rect: Rect,
  isLocked: (id: string) => boolean,
): readonly string[] {
  const corners: readonly (readonly [Point, Point])[] = [
    [
      { x: rect.x, y: rect.y },
      { x: rect.x + rect.w, y: rect.y },
    ],
    [
      { x: rect.x + rect.w, y: rect.y },
      { x: rect.x + rect.w, y: rect.y + rect.h },
    ],
    [
      { x: rect.x + rect.w, y: rect.y + rect.h },
      { x: rect.x, y: rect.y + rect.h },
    ],
    [
      { x: rect.x, y: rect.y + rect.h },
      { x: rect.x, y: rect.y },
    ],
  ]
  return paths
    .filter((entry) => entry.ink === true && !isLocked(entry.id))
    .filter((entry) =>
      entry.path.some((point, i) => {
        if (inside(point, rect)) return true
        const next = entry.path[i + 1]
        if (next === undefined) return false
        return corners.some(([a, b]) => segmentsCross(point, next, a, b))
      }),
    )
    .map((entry) => entry.id)
}
