// Where a comment's bubble goes, given what is already on the canvas. The
// fixed down-right offset covered whatever sat down-right of the anchor —
// a neighbouring node, or the bubble of the comment before it — which is
// exactly the surface a reader was trying to see. The placer keeps that
// offset as its FIRST choice and gives it up only when it collides.
import { describe, expect, it } from 'vitest'
import type { BoundingBox } from '../scene-graph.js'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import {
  COMMENT_BUBBLE_OFFSET_PX,
  COMMENT_BUBBLE_RING_REACH_PX,
  commentBubbleCandidates,
  placeCommentBubble,
} from './comment-placement.js'

const D = COMMENT_BUBBLE_OFFSET_PX
const SIZE = { w: 120, h: 40 }

/** Overlap area, written from the definition rather than the placer's helper. */
function overlapArea(a: BoundingBox, b: BoundingBox): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

function totalOverlap(box: BoundingBox, obstacles: readonly BoundingBox[]): number {
  return obstacles.reduce((sum, o) => sum + overlapArea(box, o), 0)
}

describe('placeCommentBubble', () => {
  it('keeps the down-right offset when nothing is in the way', () => {
    expect(placeCommentBubble({ x: 100, y: 100 }, SIZE, [])).toEqual({
      x: 100 + D,
      y: 100 + D,
      ...SIZE,
    })
  })

  it('moves up-right when a node sits down-right of the anchor', () => {
    const node = { x: 110, y: 110, w: 200, h: 100 }
    const placed = placeCommentBubble({ x: 100, y: 100 }, SIZE, [node])
    expect(placed).toEqual({ x: 100 + D, y: 100 - D - SIZE.h, ...SIZE })
    expect(overlapArea(placed, node)).toBe(0)
  })

  it('moves to the left when both right-hand quadrants are taken', () => {
    const right = { x: 105, y: -500, w: 400, h: 1000 }
    const placed = placeCommentBubble({ x: 100, y: 100 }, SIZE, [right])
    expect(placed).toEqual({ x: 100 - D - SIZE.w, y: 100 + D, ...SIZE })
  })

  it('treats an earlier bubble as an obstacle, so stacked comments fan out', () => {
    const first = placeCommentBubble({ x: 100, y: 100 }, SIZE, [])
    const second = placeCommentBubble({ x: 104, y: 104 }, SIZE, [first])
    expect(overlapArea(first, second)).toBe(0)
  })

  // What the ring changed, stated as the case it was built for. An anchor
  // inside a node has no free quadrant: before the ring the placer took the
  // least-covered of four boxes that all sat on the node, and stayed put.
  it('escapes an anchor with no free quadrant, instead of settling for the least bad one', () => {
    // 200 square, anchored at its centre: every quadrant sits on it, and its
    // far edge is 100px away — inside the ring's reach. A node too big for
    // the reach is a different case and is the one below.
    const box = { x: 0, y: 0, w: 200, h: 200 }
    const anchor = { x: 100, y: 100 }
    const placed = placeCommentBubble(anchor, SIZE, [box])
    expect(overlapArea(placed, box)).toBe(0)
    // Still near what it is about: bounded by the reach, not a free-for-all.
    const distance = Math.hypot(
      placed.x + placed.w / 2 - anchor.x,
      placed.y + placed.h / 2 - anchor.y,
    )
    expect(distance).toBeLessThanOrEqual(COMMENT_BUBBLE_RING_REACH_PX + Math.hypot(SIZE.w, SIZE.h))
  })

  // The quadrants still lead, which is what keeps a board with room drawing
  // exactly as it did: a clean down-right beats every ring candidate on the
  // tie at zero, because ties go to the earliest.
  it('prefers a clean quadrant over the ring', () => {
    const farAway = { x: 5000, y: 5000, w: 10, h: 10 }
    expect(placeCommentBubble({ x: 100, y: 100 }, SIZE, [farAway])).toEqual({
      x: 100 + D,
      y: 100 + D,
      ...SIZE,
    })
  })

  // Boxed in past the ring's reach — a node larger than 180px around the
  // anchor — the placer has nowhere clean and is back to picking the
  // least-covered. The ring bounds the escape rather than guaranteeing one,
  // and that fallback is what keeps a bubble on screen at all.
  it('still takes the least-covered candidate when the ring is blocked too', () => {
    const sea = { x: -2000, y: -2000, w: 4000, h: 4000 }
    const placed = placeCommentBubble({ x: 200, y: 200 }, SIZE, [sea])
    const scores = commentBubbleCandidates({ x: 200, y: 200 }, SIZE).map((c) =>
      totalOverlap(c, [sea]),
    )
    expect(totalOverlap(placed, [sea])).toBe(Math.min(...scores))
  })

  // The placer is a search over its candidate list, so its whole contract is
  // "the least-covered one, ties to the earlier" — which is what makes the
  // examples above illustrations rather than the guard. An oracle that
  // scores the candidates from the definition of overlap shares nothing
  // with the placer, and widening the list does not weaken it: the property
  // reads the same list the placer searches.
  const box = fc.record({
    x: fc.integer({ min: -300, max: 300 }),
    y: fc.integer({ min: -300, max: 300 }),
    w: fc.integer({ min: 1, max: 250 }),
    h: fc.integer({ min: 1, max: 250 }),
  })
  fcTest.prop(
    [
      fc.record({ x: fc.integer({ min: -200, max: 200 }), y: fc.integer({ min: -200, max: 200 }) }),
      fc.record({ w: fc.integer({ min: 1, max: 200 }), h: fc.integer({ min: 1, max: 120 }) }),
      fc.array(box, { maxLength: 6 }),
    ],
    withDefaults(),
  )('picks the least-covered candidate, earliest on a tie', (anchor, size, obstacles) => {
    const candidates = commentBubbleCandidates(anchor, size)
    const placed = placeCommentBubble(anchor, size, obstacles)
    const scores = candidates.map((c) => totalOverlap(c, obstacles))
    const best = Math.min(...scores)
    const expected = candidates[scores.indexOf(best)]
    expect(placed).toEqual(expected)
  })
})
