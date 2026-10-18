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
import {
  PLACEMENT_GUTTER_PX,
  PLACEMENT_WORK_PER_BATCH,
  PlacementMeter,
  placeWithin,
} from './canvas-edit-placement.js'

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

/**
 * A staircase of narrow members, each one pixel right of and one pixel
 * taller than the last, and an arriving node so wide that the box is one
 * pixel short of room for it after the last of them. Every candidate in a
 * row crowds every member still standing, each step clears only one, and
 * each row ends one member shorter: a walk that asks for the earliest
 * crowding member per step reads the whole bucket once per step, so the
 * walk is cubic in the staircase.
 */
const STAIRS = 200
const WIDE = 10_000
/**
 * Quadratic is the floor for this shape — each of its STAIRS rows has to
 * look at the members still standing in it — so the ceiling allows a
 * constant number of reads per member per row. The walk that re-read the
 * bucket per step read these 200 members 5,595,500 times.
 */
const STAIR_READ_CEILING = 8 * STAIRS * STAIRS

function countingStairs(count: number): { rects: Rect[]; reads: () => number } {
  let reads = 0
  const rects = Array.from({ length: count }, (_, i) => {
    const rect: Rect = {
      x: PLACEMENT_GUTTER_PX + i,
      y: PLACEMENT_GUTTER_PX,
      width: 1,
      height: 1 + i,
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

describe('placeWithin cost against a staircase', () => {
  it('reads a staircase of members a bounded number of times per row', () => {
    const lastStep = PLACEMENT_GUTTER_PX + (STAIRS - 1) + 1 + PLACEMENT_GUTTER_PX
    const box = { x: 0, y: 0, width: lastStep + WIDE - 1, height: 1000 }
    const held = countingStairs(STAIRS)
    const placed = placeWithin(box, [{ width: WIDE, height: 1 }], held.rects)
    // Under the whole staircase, at the row's start: the box had room nowhere above.
    expect(placed).toEqual([{ x: PLACEMENT_GUTTER_PX, y: STAIRS + 2 * PLACEMENT_GUTTER_PX }])
    expect(held.reads()).toBeLessThanOrEqual(STAIR_READ_CEILING)
  })
})

describe('placeWithin work budget', () => {
  // The costliest ordinary batch measured: a column of one-pixel members as
  // tall as a canvas allows, and the most ops a batch may carry, each adding
  // one node and so walking every row of the column again.
  const COLUMN = 1800
  const OPS = 200

  it('admits a batch of node.add ops into the tallest column a canvas holds', () => {
    const box = { x: 0, y: 0, width: 1 + 2 * PLACEMENT_GUTTER_PX, height: 1000 }
    const held: Rect[] = Array.from({ length: COLUMN }, (_, i) => ({
      x: PLACEMENT_GUTTER_PX,
      y: PLACEMENT_GUTTER_PX + i * (1 + PLACEMENT_GUTTER_PX),
      width: 1,
      height: 1,
    }))
    const meter = new PlacementMeter(PLACEMENT_WORK_PER_BATCH)
    for (let op = 0; op < OPS; op++) {
      const placed = placeWithin(box, [{ width: 1, height: 1 }], held, meter)
      expect(placed, `op ${op}`).toBeDefined()
      held.push({ ...(placed?.[0] as { x: number; y: number }), width: 1, height: 1 })
    }
    // A ceiling, not a delay: measured 1.0s alone and 3.5s beside the rest of the project.
  }, 20_000)

  it('stops a staircase walk once the meter runs out', () => {
    const lastStep = PLACEMENT_GUTTER_PX + STAIRS + PLACEMENT_GUTTER_PX
    const box = { x: 0, y: 0, width: lastStep + WIDE - 1, height: 1000 }
    const held = countingStairs(STAIRS).rects
    expect(placeWithin(box, [{ width: WIDE, height: 1 }], held, new PlacementMeter(1000))).toBe(
      undefined,
    )
  })
})
