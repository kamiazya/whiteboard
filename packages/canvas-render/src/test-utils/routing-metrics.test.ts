// The oracle needs its own check: an aggregate report is only worth reading
// if the numbers under it are right, and every value here is hand-computed
// against a picture rather than recorded from a run.
import { describe, expect, it } from 'vitest'
import { bends, borderInk, crossings, interiorInk, pathLength } from './routing-metrics.js'

const box = { x: 100, y: 100, w: 200, h: 100 } // x 100..300, y 100..200

describe('interiorInk', () => {
  it('measures the part of a crossing segment that is inside', () => {
    expect(
      interiorInk(
        [
          { x: 0, y: 150 },
          { x: 400, y: 150 },
        ],
        box,
      ),
    ).toBe(200)
  })

  it('measures a partial entry up to the far border', () => {
    expect(
      interiorInk(
        [
          { x: 200, y: 150 },
          { x: 500, y: 150 },
        ],
        box,
      ),
    ).toBe(100)
  })

  it('counts nothing for a segment lying exactly along a border', () => {
    expect(
      interiorInk(
        [
          { x: 0, y: 100 },
          { x: 400, y: 100 },
        ],
        box,
      ),
    ).toBe(0)
    expect(
      interiorInk(
        [
          { x: 300, y: 0 },
          { x: 300, y: 400 },
        ],
        box,
      ),
    ).toBe(0)
  })

  it('counts nothing for a segment that misses the box', () => {
    expect(
      interiorInk(
        [
          { x: 0, y: 50 },
          { x: 400, y: 50 },
        ],
        box,
      ),
    ).toBe(0)
  })

  it('measures a diagonal by its own length, not its projection', () => {
    // Enters at (100,100), leaves at (200,200) — a 45° chord of the corner.
    expect(
      interiorInk(
        [
          { x: 0, y: 0 },
          { x: 200, y: 200 },
        ],
        box,
      ),
    ).toBeCloseTo(Math.hypot(100, 100), 9)
  })

  it('sums across the segments of a polyline', () => {
    const path = [
      { x: 0, y: 150 },
      { x: 200, y: 150 },
      { x: 200, y: 400 },
    ]
    expect(interiorInk(path, box)).toBe(100 + 50)
  })
})

describe('borderInk', () => {
  it('measures the overlap of a segment lying along a border', () => {
    expect(
      borderInk(
        [
          { x: 0, y: 100 },
          { x: 400, y: 100 },
        ],
        box,
      ),
    ).toBe(200)
    expect(
      borderInk(
        [
          { x: 150, y: 200 },
          { x: 400, y: 200 },
        ],
        box,
      ),
    ).toBe(150)
  })

  it('counts nothing for an interior or an outside segment', () => {
    expect(
      borderInk(
        [
          { x: 0, y: 150 },
          { x: 400, y: 150 },
        ],
        box,
      ),
    ).toBe(0)
    expect(
      borderInk(
        [
          { x: 0, y: 99 },
          { x: 400, y: 99 },
        ],
        box,
      ),
    ).toBe(0)
  })

  it('is the complement of interiorInk — no length is counted by both', () => {
    for (const path of [
      [
        { x: 0, y: 100 },
        { x: 400, y: 100 },
      ],
      [
        { x: 0, y: 150 },
        { x: 400, y: 150 },
      ],
      [
        { x: 100, y: 0 },
        { x: 100, y: 400 },
      ],
    ]) {
      expect(Math.min(interiorInk(path, box), borderInk(path, box))).toBe(0)
    }
  })
})

describe('bends and pathLength', () => {
  it('counts a corner per direction change', () => {
    expect(
      bends([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ]),
    ).toBe(0)
    expect(
      bends([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 20, y: 0 },
      ]),
    ).toBe(0)
    expect(
      bends([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ]),
    ).toBe(1)
    expect(
      bends([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 20, y: 10 },
      ]),
    ).toBe(2)
  })

  it('sums segment lengths', () => {
    expect(
      pathLength([
        { x: 0, y: 0 },
        { x: 3, y: 4 },
        { x: 3, y: 14 },
      ]),
    ).toBe(15)
  })
})

describe('crossings', () => {
  it('counts a clean cross once', () => {
    expect(
      crossings([
        [
          { x: 0, y: 5 },
          { x: 10, y: 5 },
        ],
        [
          { x: 5, y: 0 },
          { x: 5, y: 10 },
        ],
      ]),
    ).toBe(1)
  })

  it('ignores a touch at an endpoint and a shared corner', () => {
    expect(
      crossings([
        [
          { x: 0, y: 5 },
          { x: 10, y: 5 },
        ],
        [
          { x: 5, y: 5 },
          { x: 5, y: 10 },
        ],
      ]),
    ).toBe(0)
  })

  it('ignores segments of the same path meeting each other', () => {
    expect(
      crossings([
        [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
        ],
      ]),
    ).toBe(0)
  })
})
