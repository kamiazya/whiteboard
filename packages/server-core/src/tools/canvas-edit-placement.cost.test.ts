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

/**
 * Bucket reads, counted, with a budget past which the walk throws. A walk that
 * stops advancing is synchronous, so no vitest timeout can interrupt it: the
 * count is what turns a hang into a failure. Every bucket `TakenRows` files or
 * reads goes through `Map.prototype.get`, and every row and column step reads
 * the arriving size, so both are counted.
 */
const BUCKET_READ_BUDGET = 10_000

function withinReadBudget<T>(run: (count: () => void) => T): T {
  let reads = 0
  const count = () => {
    reads += 1
    if (reads > BUCKET_READ_BUDGET) {
      throw new Error(`placement read ${BUCKET_READ_BUDGET} buckets without finishing`)
    }
  }
  const get = Map.prototype.get
  Map.prototype.get = function (this: Map<unknown, unknown>, key: unknown) {
    count()
    return get.call(this, key)
  }
  try {
    return run(count)
  } finally {
    Map.prototype.get = get
  }
}

function countedSizes(count: () => void, length: number): { width: number; height: number }[] {
  return Array.from(
    { length },
    () =>
      new Proxy(
        { width: 100, height: 50 },
        {
          get(target, key: 'width' | 'height') {
            count()
            return target[key]
          },
        },
      ),
  )
}

describe('placeWithin far from the origin', () => {
  // Past 2^53 * 512 a bucket index no longer changes when incremented, and
  // past about 2^60 adding a height and the gutter no longer moves a
  // coordinate. Both are reachable: a position is any finite number.
  for (const [axis, box] of [
    ['y', { x: 0, y: 1e20, width: 400, height: 400 }],
    ['x', { x: 1e20, y: 0, width: 400, height: 400 }],
  ] as const) {
    it(`finishes for a box at ${axis} = 1e20`, () => {
      const placed = withinReadBudget((count) => placeWithin(box, countedSizes(count, 6), []))
      expect(placed).toHaveLength(6)
    })
  }

  it('finishes for a box near the origin holding rects at 1e20', () => {
    const box = { x: 0, y: 0, width: 400, height: 400 }
    const held = [
      { x: 40, y: 1e20, width: 100, height: 50 },
      { x: 1e20, y: 40, width: 100, height: 50 },
      { x: 40, y: 40, width: 100, height: 1e20 },
    ]
    const placed = withinReadBudget((count) => placeWithin(box, countedSizes(count, 6), held))
    expect(placed).toHaveLength(6)
  })
})
