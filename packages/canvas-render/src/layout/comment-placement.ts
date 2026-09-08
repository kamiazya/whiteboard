/**
 * Where a comment's bubble sits relative to its anchor.
 *
 * A bubble floats beside the anchor (ADR-0024: placement is a rendering
 * decision, never stored), and the one rule that matters is that it does
 * not cover what the comment is about. Four candidates — the diagonal
 * quadrants around the anchor, down-right first because that is where a
 * bubble has always gone — are scored by how much of each would lie over
 * an obstacle, and the least-covered one wins, earliest on a tie. A fully
 * boxed-in anchor still gets a bubble: the fallback is the least bad
 * quadrant, never no bubble.
 *
 * Obstacles are whatever the caller wants kept visible: the canvas's nodes
 * and the bubbles placed before this one, so clustered comments fan out
 * instead of stacking. Group frames are deliberately NOT obstacles (see
 * `composeComments`): a comment inside a group would otherwise be pushed
 * out of the frame, past the members it is about.
 *
 * **Past the four quadrants there is a RING**, and it is what the four alone
 * could not do: every one of them sits a single 14px offset from the anchor,
 * so a boxed-in anchor had nowhere to go and the placer took the least bad
 * quadrant and stayed put. Measured on the annotation-density corpus, that
 * left one clean bubble in forty on a crowded board — for comments and
 * proposals alike, since both are placed here.
 *
 * The four stay FIRST, and that is load-bearing rather than tidy: ties go to
 * the earliest candidate, so wherever a quadrant is already clean the answer
 * is the one it always was. An uncrowded board is unchanged by construction,
 * which is what stops a ring bought for a crowded board from spending the
 * uncrowded one.
 */

import type { BoundingBox } from '../scene-graph.js'

/** Gap (px) from the anchor point to the bubble's nearest corner. */
export const COMMENT_BUBBLE_OFFSET_PX = 14

export interface Point {
  readonly x: number
  readonly y: number
}

export interface Size {
  readonly w: number
  readonly h: number
}

/**
 * How far out the ring reaches. A leader is the price of a clean bubble, and
 * this is where the corpus stopped paying: measured at forty proposals on a
 * crowded board, reaching 180px buys 22 clean bubbles of 40 for a mean
 * leader of 193px, and reaching 440px buys all 40 for 279px mean and 536px
 * worst — a bubble that far from what it is about is not obviously better
 * than one that overlaps something.
 *
 * It is also what the search COSTS: 4 candidates become 68, and each is
 * scored against every obstacle. Measured interleaved in both orders on the
 * crowded forty-annotation boards, laying one out goes 0.55-0.64ms ->
 * 1.97-2.14ms (proposals) and 0.42-0.47ms -> 2.18-2.34ms (comments) — about
 * 3.4x, and under 2ms either way. A canvas with no annotation on it pays
 * nothing, because the placer is not called.
 */
export const COMMENT_BUBBLE_RING_REACH_PX = 180

/**
 * Directions around the anchor, and the distances tried at each. The last
 * distance IS the reach rather than being filtered against it: a guard
 * comparing the two never fires while every distance is inside it, which is
 * dead code wearing a constant's clothes — the mutation lane reported
 * exactly that, as a survivor no test could kill.
 *
 * The ring closes on itself, so an off-by-one in the direction loop only
 * repeats the first direction. That candidate ties with the one already
 * there and loses on the earliest-wins rule, which is why it is unkillable
 * too, and equivalent rather than a gap.
 */
const RING_DIRECTIONS = 16
const RING_DISTANCES_PX = [40, 80, 120, COMMENT_BUBBLE_RING_REACH_PX] as const

/**
 * The candidate boxes in preference order: the four diagonal quadrants
 * (down-right, up-right, down-left, up-left) first, then a ring outwards,
 * nearest distance first. The quadrants lead so that a board with room
 * answers exactly as it did before the ring existed.
 */
export function commentBubbleCandidates(anchor: Point, size: Size): readonly BoundingBox[] {
  const d = COMMENT_BUBBLE_OFFSET_PX
  const right = anchor.x + d
  const left = anchor.x - d - size.w
  const below = anchor.y + d
  const above = anchor.y - d - size.h
  const out: BoundingBox[] = [
    { x: right, y: below, ...size },
    { x: right, y: above, ...size },
    { x: left, y: below, ...size },
    { x: left, y: above, ...size },
  ]
  // The ring is placed by its CENTRE on the ray, unlike the quadrants which
  // hang a corner off the anchor: a direction has no corner to choose, and
  // centring is what makes the sixteen evenly spaced rather than bunched.
  for (const distance of RING_DISTANCES_PX) {
    for (let k = 0; k < RING_DIRECTIONS; k += 1) {
      const angle = (k / RING_DIRECTIONS) * 2 * Math.PI
      const centerX = anchor.x + Math.cos(angle) * (distance + size.w / 2)
      const centerY = anchor.y + Math.sin(angle) * (distance + size.h / 2)
      out.push({ x: centerX - size.w / 2, y: centerY - size.h / 2, ...size })
    }
  }
  return out
}

export function placeCommentBubble(
  anchor: Point,
  size: Size,
  obstacles: readonly BoundingBox[],
): BoundingBox {
  const candidates = commentBubbleCandidates(anchor, size)
  let best = candidates[0] as BoundingBox
  let bestCovered = Number.POSITIVE_INFINITY
  // Strictly less, so an earlier candidate keeps a tie — including a tie at
  // zero, which is why a free quadrant needs no early return of its own.
  for (const candidate of candidates) {
    const covered = coveredArea(candidate, obstacles)
    if (covered < bestCovered) {
      best = candidate
      bestCovered = covered
    }
  }
  return best
}

/**
 * The point on the bubble's rounded corner nearest the anchor — where the
 * leader from the pin ends. The bbox corner itself sits outside a rounded
 * fill, which leaves a visible gap between the dash end and the border, so
 * the end is inset diagonally onto the arc.
 */
export function commentLeaderEnd(anchor: Point, bubble: BoundingBox, radius: number): Point {
  const inset = radius * (1 - Math.SQRT1_2)
  const centerX = bubble.x + bubble.w / 2
  const centerY = bubble.y + bubble.h / 2
  // `<=` and `<` cannot differ for a placed bubble: every candidate sits a
  // whole offset to one side of the anchor on each axis, so the anchor is
  // never on a centre line. The equal case is unreachable, not decided.
  return {
    x: anchor.x <= centerX ? bubble.x + inset : bubble.x + bubble.w - inset,
    y: anchor.y <= centerY ? bubble.y + inset : bubble.y + bubble.h - inset,
  }
}

function coveredArea(box: BoundingBox, obstacles: readonly BoundingBox[]): number {
  let sum = 0
  for (const obstacle of obstacles) {
    const w = Math.min(box.x + box.w, obstacle.x + obstacle.w) - Math.max(box.x, obstacle.x)
    const h = Math.min(box.y + box.h, obstacle.y + obstacle.h) - Math.max(box.y, obstacle.y)
    // A zero-width or zero-height overlap contributes nothing either way;
    // the guard only keeps a negative extent from being multiplied.
    if (w > 0 && h > 0) sum += w * h
  }
  return sum
}

/**
 * The point of a polyline nearest to `point` — where a comment about an
 * edge is pinned: the reader pressed somewhere near the line, and the pin
 * sits ON it, re-projected from the stored point each layout so it rides a
 * reroute. An empty path answers the point itself.
 */
export function nearestPointOnPolyline(point: Point, path: readonly Point[]): Point {
  let best = point
  let bestDistance = Number.POSITIVE_INFINITY
  for (let i = 0; i < path.length; i += 1) {
    const a = path[i] as Point
    const b = path[i + 1] ?? a
    const dx = b.x - a.x
    const dy = b.y - a.y
    const lengthSquared = dx * dx + dy * dy
    const t =
      lengthSquared === 0
        ? 0
        : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared))
    const candidate = { x: a.x + t * dx, y: a.y + t * dy }
    const distance = (candidate.x - point.x) ** 2 + (candidate.y - point.y) ** 2
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}
