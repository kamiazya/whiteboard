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
 * ponytail: four diagonal candidates; an anchor sitting inside a node has
 * no free quadrant and lands on the least-covered one. The upgrade path is
 * a second ring of candidates beside the containing node's edges.
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

/** The candidate boxes in preference order: down-right, up-right, down-left, up-left. */
export function commentBubbleCandidates(anchor: Point, size: Size): readonly BoundingBox[] {
  const d = COMMENT_BUBBLE_OFFSET_PX
  const right = anchor.x + d
  const left = anchor.x - d - size.w
  const below = anchor.y + d
  const above = anchor.y - d - size.h
  return [
    { x: right, y: below, ...size },
    { x: right, y: above, ...size },
    { x: left, y: below, ...size },
    { x: left, y: above, ...size },
  ]
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
