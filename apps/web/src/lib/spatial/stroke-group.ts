/**
 * Which strokes the pen treats as ONE mark.
 *
 * A handwritten character is several strokes and a person means one thing by
 * them, so a stroke joins the one before it when the hand never really left:
 * it went down soon after the last one came up, AND it started near where
 * that one was drawn. Both, because either alone is wrong — a stroke minutes
 * later in the same place is a correction, and one an instant later across
 * the board is a different mark made quickly.
 *
 * The two thresholds below are DEFAULTS chosen from the ordinary cadence of
 * handwriting, not measurements taken on this product's users. That is worth
 * saying plainly: nothing here has been calibrated, and the honest instrument
 * is somebody writing on a real board and reporting that it groups too
 * eagerly or not enough. They are named constants so that report has one
 * place to land.
 */
import type { Point } from './viewport.js'

/**
 * How long a hand may pause between two strokes of one mark, in ms. Past it
 * the next stroke starts its own group, however near it lands.
 */
export const STROKE_GROUP_PAUSE_MS = 700

/**
 * How far the next stroke may start from the last one's box, in SCREEN
 * pixels — a screen distance for the same reason the pen's other thresholds
 * are: what reads as "the same mark" is what the eye sees, so zooming out
 * must not silently merge two marks that look far apart.
 */
export const STROKE_GROUP_GAP_PX = 48

/** The axis-aligned box a stroke's points occupy. */
export interface StrokeBounds {
  readonly minX: number
  readonly minY: number
  readonly maxX: number
  readonly maxY: number
}

export function strokeBounds(points: readonly Point[]): StrokeBounds | undefined {
  const first = points[0]
  if (first === undefined) return undefined
  let box = { minX: first.x, minY: first.y, maxX: first.x, maxY: first.y }
  for (const point of points) {
    box = {
      minX: Math.min(box.minX, point.x),
      minY: Math.min(box.minY, point.y),
      maxX: Math.max(box.maxX, point.x),
      maxY: Math.max(box.maxY, point.y),
    }
  }
  return box
}

/** Distance from `point` to the box, zero when it is inside. */
function distanceToBounds(point: Point, box: StrokeBounds): number {
  const dx = Math.max(box.minX - point.x, 0, point.x - box.maxX)
  const dy = Math.max(box.minY - point.y, 0, point.y - box.maxY)
  return Math.hypot(dx, dy)
}

/** What the last stroke left behind, for the next one to be judged against. */
export interface PreviousStroke {
  readonly group: string
  /** When the pointer came up, in the same clock the next press reads. */
  readonly endedAt: number
  /** Where it was drawn, in CANVAS coordinates. */
  readonly bounds: StrokeBounds
}

/**
 * Whether a stroke starting at `startedAt`/`at` continues `previous`.
 *
 * `zoom` converts the screen-sized gap into canvas units, so the same hand
 * movement means the same thing at any magnification.
 */
export function continuesStroke(
  previous: PreviousStroke | undefined,
  startedAt: number,
  at: Point,
  zoom: number,
): boolean {
  if (previous === undefined) return false
  const paused = startedAt - previous.endedAt
  // A press that reads as arriving BEFORE the last release is a clock nobody
  // can trust (a restored session, two pointers, a paused tab); treat it as
  // no continuation rather than as an instant one.
  if (paused < 0 || paused > STROKE_GROUP_PAUSE_MS) return false
  const scale = zoom > 0 && Number.isFinite(zoom) ? zoom : 1
  return distanceToBounds(at, previous.bounds) <= STROKE_GROUP_GAP_PX / scale
}
