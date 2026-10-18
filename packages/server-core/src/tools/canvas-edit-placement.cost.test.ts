/**
 * What packing nodes into a group costs, COUNTED rather than timed so the
 * number is the same on any machine and under any load.
 *
 * The count is reads of what the box already HOLDS: every crowding test
 * `placeWithin` makes against an existing member reads that member's
 * geometry, so a proxy over each held rect sees the work without asking the
 * code under test for a number. The shape is the expensive one — a box one
 * member wide, already holding a column of members, taking as many again —
 * which is what moving a column of members from one narrow group to another
 * asks of it.
 */
import { describe, expect, it } from 'vitest'
import { PLACEMENT_GUTTER_PX, placeWithin } from './canvas-edit-placement.js'

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

const HELD = 200
const ARRIVING = 200
/**
 * A constant number of reads per rect, never one per pair. Measured at about
 * 14 per rect; the search that restarted at the top row and scanned every
 * taken rect read these 200 held rects 40,400,000 times.
 */
const READ_CEILING = 20 * (HELD + ARRIVING)
const WIDTH = 200
const HEIGHT = 60

function countingHeld(count: number): { rects: Rect[]; reads: () => number } {
  let reads = 0
  const rects = Array.from({ length: count }, (_, i) => {
    const rect: Rect = {
      x: PLACEMENT_GUTTER_PX,
      y: PLACEMENT_GUTTER_PX + i * (HEIGHT + PLACEMENT_GUTTER_PX),
      width: WIDTH,
      height: HEIGHT,
    }
    return new Proxy(rect, {
      get(target, key: keyof Rect) {
        reads += 1
        return target[key]
      },
    })
  })
  return { rects, reads: () => reads }
}

describe('placeWithin cost', () => {
  it('reads what a one-column box holds a constant number of times per rect', () => {
    const box = { x: 0, y: 0, width: WIDTH + 2 * PLACEMENT_GUTTER_PX, height: 1000 }
    const held = countingHeld(HELD)
    const sizes = Array.from({ length: ARRIVING }, () => ({ width: WIDTH, height: HEIGHT }))
    const placed = placeWithin(box, sizes, held.rects)
    expect(placed).toHaveLength(ARRIVING)
    expect(held.reads()).toBeLessThanOrEqual(READ_CEILING)
  })
})
