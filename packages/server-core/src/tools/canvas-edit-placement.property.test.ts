/**
 * `placeWithin` is a packing loop whose termination argument lives in a
 * comment — "every hit sits at or below y with the gutter, so this strictly
 * advances" — inside two nested `for(;;)`. Nothing asserted it, and the
 * function is reached only through `wb_canvas_edit`'s integration tests,
 * where a placement that overlaps looks like a slightly odd canvas rather
 * than a failure.
 *
 * Three claims, stated where a generator can attack them:
 *
 *   1. it TERMINATES. Measured, and the failure mode is worth knowing
 *      before you meet it: removing the gutter from the step past a
 *      blocker makes a candidate at `hit.x + hit.width` still CROWD that
 *      hit, so `x` stops advancing and the inner loop never ends. Vitest's
 *      per-test timeout cannot interrupt it — the loop is synchronous, so
 *      it blocks the event loop and no timer fires. The suite HANGS rather
 *      than reporting a failure. That is still the property doing its job;
 *      just do not wait for a red line that will not come.
 *   2. it places EVERY node it was given;
 *   3. nothing it places crowds anything — neither what the box already
 *      held nor another node from the same call.
 *
 * Containment is asserted only for nodes that FIT: the function's own
 * `ponytail:` note says a node wider than the box overflows rather than
 * being shrunk, because the caller grows the box.
 */
import { describe, expect } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { PLACEMENT_GUTTER_PX, placeWithin } from './canvas-edit-placement.js'

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * The same predicate `placeWithin` packs against, restated rather than
 * imported: it is not exported, and a property that asked the code under
 * test what "overlapping" means would agree with it by construction.
 */
function crowds(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width + PLACEMENT_GUTTER_PX &&
    b.x < a.x + a.width + PLACEMENT_GUTTER_PX &&
    a.y < b.y + b.height + PLACEMENT_GUTTER_PX &&
    b.y < a.y + a.height + PLACEMENT_GUTTER_PX
  )
}

const size = fc.record({
  width: fc.integer({ min: 1, max: 400 }),
  height: fc.integer({ min: 1, max: 300 }),
})

const box = fc.record({
  x: fc.integer({ min: -500, max: 500 }),
  y: fc.integer({ min: -500, max: 500 }),
  width: fc.integer({ min: 1, max: 900 }),
  height: fc.integer({ min: 1, max: 900 }),
})

/** Rects already in the box, including ones that straddle its edges. */
const occupied = fc.array(
  fc.record({
    x: fc.integer({ min: -600, max: 900 }),
    y: fc.integer({ min: -600, max: 900 }),
    width: fc.integer({ min: 1, max: 400 }),
    height: fc.integer({ min: 1, max: 300 }),
  }),
  { maxLength: 6 },
)

describe('placeWithin', () => {
  fcTest.prop([box, fc.array(size, { minLength: 1, maxLength: 8 }), occupied], withDefaults())(
    'places every node, and none of them crowds anything',
    (boxRect, sizes, taken) => {
      const placed = placeWithin(boxRect, sizes, taken)

      // (2) every node got a position — the caller indexes these by order.
      expect(placed).toHaveLength(sizes.length)

      const rects = placed.map((at, index) => ({ ...at, ...(sizes[index] as (typeof sizes)[0]) }))

      // (3a) nothing lands on what the box already held.
      for (const rect of rects) {
        for (const held of taken) {
          expect(crowds(rect, held)).toBe(false)
        }
      }

      // (3b) and nothing lands on a sibling from this same call.
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          expect(crowds(rects[i] as Rect, rects[j] as Rect)).toBe(false)
        }
      }
    },
  )

  fcTest.prop([box, fc.array(size, { minLength: 1, maxLength: 6 })], withDefaults())(
    'a node that fits the box stays inside it horizontally',
    (boxRect, sizes) => {
      const placed = placeWithin(boxRect, sizes, [])
      placed.forEach((at, index) => {
        const width = (sizes[index] as (typeof sizes)[0]).width
        // The ponytail note: one wider than the box overflows on purpose.
        if (width + PLACEMENT_GUTTER_PX > boxRect.width) return
        expect(at.x).toBeGreaterThanOrEqual(boxRect.x + PLACEMENT_GUTTER_PX)
        expect(at.x + width).toBeLessThanOrEqual(boxRect.x + boxRect.width)
      })
    },
  )
})

/**
 * NOT asserted here, deliberately: how TIGHTLY it packs. Taking the max
 * row instead of the min leaves both properties green — the placements are
 * still valid, just sparser — and that is correct. `placeWithin`'s own
 * `ponytail:` note says dense packing is explicitly not a goal yet ("Pack
 * properly if regions turn out to be used for dense layouts"), so a
 * density assertion would pin a promise the function has not made.
 */
