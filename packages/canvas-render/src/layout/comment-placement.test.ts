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

  it('falls back to the least-covered candidate, in candidate order on a tie', () => {
    // Anchor inside a large node: every quadrant overlaps it equally, so the
    // first candidate (down-right) wins the tie...
    const big = { x: 0, y: 0, w: 400, h: 400 }
    expect(placeCommentBubble({ x: 200, y: 200 }, SIZE, [big])).toEqual({
      x: 200 + D,
      y: 200 + D,
      ...SIZE,
    })
    // ...unless something ELSE also covers it, when the next-least-covered
    // quadrant is taken instead.
    const alsoDownRight = { x: 200 + D, y: 200 + D, w: 300, h: 300 }
    expect(placeCommentBubble({ x: 200, y: 200 }, SIZE, [big, alsoDownRight])).toEqual({
      x: 200 + D,
      y: 200 - D - SIZE.h,
      ...SIZE,
    })
  })

  it('compares covered AREA, not the shape of the overlap', () => {
    // Both left-hand quadrants are walled off. Down-right is crossed by a
    // thin strip the bubble's full height (2 x 40 = 80); up-right holds a
    // small block (4 x 4 = 16). The block covers less, whatever its aspect.
    const leftWall = { x: -600, y: -600, w: 690, h: 1200 }
    const strip = { x: 100 + D + 10, y: 100 + D, w: 2, h: SIZE.h }
    const block = { x: 100 + D + 10, y: 100 - D - 10, w: 4, h: 4 }
    expect(placeCommentBubble({ x: 100, y: 100 }, SIZE, [leftWall, strip, block])).toEqual({
      x: 100 + D,
      y: 100 - D - SIZE.h,
      ...SIZE,
    })
  })

  // The placer is a search over four candidates, so its whole contract is
  // "the least-covered one, ties to the earlier". An oracle that scores the
  // candidates from the definition of overlap shares nothing with it.
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
