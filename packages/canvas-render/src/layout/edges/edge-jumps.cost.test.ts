// What line jumps cost as a board grows. `lineJumps: 'arc'` asks every
// render for the crossings of every routed edge and line, and a bent edge
// keeps up to MAX_BENDS of its authored points, so a pass over all segment
// pairs is paid on every render of a large board.
//
// Work, not wall time: every pair the search considers goes through
// `segmentIntersection`, so counting its calls is exact and load-independent.

import type { ResolvedEdgeNode } from '@kamiazya/whiteboard-scene'
import { describe, expect, it, vi } from 'vitest'
import { computeEdgeJumps } from './edge-jumps.js'

// `budget` makes a runaway narrow phase throw rather than grind through
// billions of pairs: the work is synchronous, so no timeout can stop it.
const narrowTests = vi.hoisted(() => ({ count: 0, budget: Number.POSITIVE_INFINITY }))

vi.mock('./segment-intersection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./segment-intersection.js')>()
  return {
    ...actual,
    segmentIntersection: (...args: Parameters<typeof actual.segmentIntersection>) => {
      narrowTests.count++
      if (narrowTests.count > narrowTests.budget) {
        throw new Error(`narrow-phase budget of ${narrowTests.budget} exceeded`)
      }
      return actual.segmentIntersection(...args)
    },
  }
})

const routed = (id: string, path: readonly { x: number; y: number }[]): ResolvedEdgeNode => ({
  kind: 'edge',
  id,
  path,
  fromSide: 'right',
  toSide: 'left',
  fromEnd: 'none',
  toEnd: 'arrow',
})

/**
 * Runs `computeEdgeJumps` counting its broad-phase cell visits — every one
 * reads the grid's cell map once — and throws once `budget` is spent. The
 * throw is what makes a runaway grid FAIL: the work is synchronous, so a
 * vitest timeout cannot interrupt it and the run would otherwise hang.
 */
function jumpsWithinCellBudget(
  edges: readonly ResolvedEdgeNode[],
  budget: number,
): { jumps: ReturnType<typeof computeEdgeJumps>; visits: number } {
  let visits = 0
  const get = Map.prototype.get
  const spy = vi.spyOn(Map.prototype, 'get').mockImplementation(function (
    this: Map<unknown, unknown>,
    key,
  ) {
    visits++
    if (visits > budget) throw new Error(`cell-visit budget of ${budget} exceeded`)
    return get.call(this, key)
  })
  try {
    return { jumps: computeEdgeJumps(edges), visits }
  } finally {
    spy.mockRestore()
  }
}

const STEP_PX = 20
const BENDS = 64

/** A staircase of `BENDS` bends starting at the origin given, 20px per step. */
function staircase(id: string, ox: number, oy: number): ResolvedEdgeNode {
  const path = [{ x: ox, y: oy }]
  for (let k = 1; k <= BENDS + 1; k++) {
    const last = path[path.length - 1]!
    path.push(k % 2 === 1 ? { x: last.x + STEP_PX, y: last.y } : { x: last.x, y: last.y + STEP_PX })
  }
  return routed(id, path)
}

const BOARD_CELLS = 1000

/**
 * 1000 staircases of 64 bends, each in its own 2000px cell, and one short
 * later edge per cell crossing its staircase's first step: 2000 edges,
 * 66_000 segments, exactly one real crossing per cell.
 */
function staircaseBoard(): ResolvedEdgeNode[] {
  const edges: ResolvedEdgeNode[] = []
  for (let i = 0; i < BOARD_CELLS; i++) {
    const ox = (i % 40) * 2000
    const oy = Math.floor(i / 40) * 2000
    edges.push(staircase(`s${i}`, ox, oy))
    edges.push(
      routed(`c${i}`, [
        { x: ox + STEP_PX / 2, y: oy - 30 },
        { x: ox + STEP_PX / 2, y: oy + 30 },
      ]),
    )
  }
  return edges
}

describe('computeEdgeJumps cost', () => {
  it('tests a bounded number of segment pairs per segment when edges keep apart', () => {
    const edges = staircaseBoard()
    const segments = edges.reduce((n, e) => n + e.path.length - 1, 0)

    narrowTests.count = 0
    const { jumps, visits } = jumpsWithinCellBudget(edges, 64 * segments)

    // The subject is present: every crosser still hops its staircase, and
    // nothing else hops at all.
    expect(jumps.size).toBe(BOARD_CELLS)
    expect(jumps.get('c0')).toEqual([{ segment: 0, x: STEP_PX / 2, y: 0 }])
    expect(jumps.get('c999')).toEqual([{ segment: 0, x: 39 * 2000 + STEP_PX / 2, y: 24 * 2000 }])
    expect(narrowTests.count).toBeGreaterThanOrEqual(BOARD_CELLS)
    // All pairs is about segments² / 2 — 2.2e9 here; 3_268 per segment at a
    // tenth of this size. Measured 4_160 in all behind the grid; a pair met
    // in two shared cells and tested twice would put it past 4_500.
    expect(narrowTests.count / segments).toBeLessThanOrEqual(0.1)
    expect(narrowTests.count).toBeLessThanOrEqual(4_200)
    expect(visits).toBeGreaterThan(segments)
    // Each segment reads its cells twice, to find candidates and to enter
    // itself. Measured 3.64 per segment.
    expect(visits / segments).toBeLessThanOrEqual(4.5)
  })

  it.each([
    {
      name: 'a zero-length line',
      far: [
        { x: -(2 ** 60), y: -(2 ** 60) },
        { x: -(2 ** 60), y: -(2 ** 60) },
      ],
    },
    {
      name: 'a short line',
      far: [
        { x: -(2 ** 60), y: -(2 ** 60) },
        { x: -(2 ** 60) + 256, y: -(2 ** 60) },
      ],
    },
    {
      name: 'a short line past 1e300',
      far: [
        { x: -1e300, y: 1e300 },
        { x: -1e300 + 1e290, y: 1e300 },
      ],
    },
  ])('keeps the same bounded pair count beside $name far away', ({ far }) => {
    // One outlier must not change what the board's own segments cost: the
    // board is the fixture above, untouched. Measured the same 4_160 pairs
    // and 3.64 visits per segment; one grid shared by the whole board spent
    // 2_175_953_000 pairs here, the outlier having widened every segment.
    const edges = [routed('far', far), ...staircaseBoard()]
    const segments = edges.reduce((n, e) => n + e.path.length - 1, 0)

    narrowTests.count = 0
    narrowTests.budget = segments
    try {
      const { jumps, visits } = jumpsWithinCellBudget(edges, 64 * segments)
      expect(jumps.size).toBe(BOARD_CELLS)
      expect(jumps.get('c999')).toEqual([{ segment: 0, x: 39 * 2000 + STEP_PX / 2, y: 24 * 2000 }])
      expect(narrowTests.count / segments).toBeLessThanOrEqual(0.1)
      // The outlier's level is never visited by the board's own segments.
      expect(visits / segments).toBeLessThanOrEqual(4.5)
    } finally {
      narrowTests.budget = Number.POSITIVE_INFINITY
    }
  })

  it('stops examining pairs past a per-scene budget on a board that never crosses', () => {
    // 2000 zigzags of 65 long, almost-horizontal segments, stacked 1px
    // apart: every segment shares its coarse cells with every other edge's,
    // yet none crosses another, so no hop cap ever engages. Examining every
    // candidate pair is 481_759_000 narrow-phase tests (1m26s measured).
    // One cross before them and one after, far from them both.
    const L = 10_000
    const zigzags = Array.from({ length: 2000 }, (_, i) =>
      routed(
        `z${i}`,
        Array.from({ length: 66 }, (_, k) => ({ x: k * L, y: i + (k % 2) * 0.25 })),
      ),
    )
    const cross = (id: string, y: number) => [
      routed(`${id}h`, [
        { x: 0, y },
        { x: 200, y },
      ]),
      routed(`${id}v`, [
        { x: 100, y: y - 100 },
        { x: 100, y: y + 100 },
      ]),
    ]
    const edges = [...cross('first', -1e6), ...zigzags, ...cross('last', -2e6)]
    narrowTests.count = 0
    narrowTests.budget = 20_000_000
    try {
      const { jumps, visits } = jumpsWithinCellBudget(edges, Number.POSITIVE_INFINITY)
      // The hop found before the budget ran out stays; none is drawn after.
      expect(new Map(jumps)).toEqual(new Map([['firstv', [{ segment: 0, x: 100, y: -1e6 }]]]))
      // Measured 3_430_363, in about 0.4s.
      expect(narrowTests.count).toBeGreaterThan(1_000_000)
      expect(narrowTests.count).toBeLessThanOrEqual(4_000_000)
      // And the segments after it are not filed either: 165_633 cell
      // visits, against 550_020 when the rest of the board is still filed.
      expect(visits).toBeLessThanOrEqual(200_000)
    } finally {
      narrowTests.budget = Number.POSITIVE_INFINITY
    }
  })

  it('caps the hops one segment draws', () => {
    // One long later edge across 1000 earlier verticals 20px apart: every
    // crossing has room for its own arc, so only the cap bounds the count.
    const verticals = Array.from({ length: 1000 }, (_, i) =>
      routed(`v${i}`, [
        { x: 100 + i * 20, y: -50 },
        { x: 100 + i * 20, y: 50 },
      ]),
    )
    const long = routed('long', [
      { x: 0, y: 0 },
      { x: 100_000, y: 0 },
    ])
    const hops = computeEdgeJumps([...verticals, long]).get('long') ?? []

    expect(hops).toHaveLength(64)
    // The cap keeps the FIRST hops along the segment.
    expect(hops[0]).toEqual({ segment: 0, x: 100, y: 0 })
    expect(hops[63]).toEqual({ segment: 0, x: 100 + 63 * 20, y: 0 })
  })

  it('caps the hops a whole scene draws', () => {
    // 200 later horizontals each crossing the same 50 verticals: 10_000
    // spaced crossings, every segment under its own cap.
    const verticals = Array.from({ length: 50 }, (_, i) =>
      routed(`v${i}`, [
        { x: 100 + i * 20, y: -10 },
        { x: 100 + i * 20, y: 10_000 },
      ]),
    )
    const horizontals = Array.from({ length: 200 }, (_, j) =>
      routed(`h${j}`, [
        { x: 0, y: j * 20 },
        { x: 2000, y: j * 20 },
      ]),
    )
    const jumps = computeEdgeJumps([...verticals, ...horizontals])
    const total = [...jumps.values()].reduce((n, hops) => n + hops.length, 0)

    expect(total).toBe(4096)
    // Earlier edges keep theirs in full; the cap falls on the later ones.
    expect(jumps.get('h0')).toHaveLength(50)
    expect(jumps.get('h199')).toBeUndefined()
  })

  it('still hops over a segment too long for the grid', () => {
    // 2_000_000px against 100px verticals: the long edge is filed at a far
    // coarser level than they are. Every later vertical must still find it
    // there, without the board falling back to all pairs.
    const long = routed('long', [
      { x: 0, y: 0 },
      { x: 2_000_000, y: 0 },
    ])
    const verticals = Array.from({ length: 2000 }, (_, i) =>
      routed(`v${i}`, [
        { x: i * 1000 + 500, y: -50 },
        { x: i * 1000 + 500, y: 50 },
      ]),
    )
    const edges = [long, ...verticals]
    narrowTests.count = 0
    const { jumps, visits } = jumpsWithinCellBudget(edges, 8 * edges.length)

    expect(jumps.size).toBe(2000)
    expect(jumps.get('v1999')).toEqual([{ segment: 0, x: 1_999_500, y: 0 }])
    expect(visits).toBeGreaterThan(0)
    expect(narrowTests.count / edges.length).toBeLessThanOrEqual(2)
  })

  describe('at coordinates far from the origin', () => {
    // A plain cross, in units of `u`, plus `zeros` zero-length edges at the
    // board's top-left, which a grid sized by the mean segment extent let
    // pull its cell down. Translated by (tx, ty); every coordinate is a multiple of `u`,
    // chosen so it is exact at that magnitude.
    function cross(u: number, zeros: number, tx: number, ty: number): ResolvedEdgeNode[] {
      const at = (x: number, y: number) => ({ x: tx + x * u, y: ty + y * u })
      return [
        routed('h', [at(0, 50), at(100, 50)]),
        ...Array.from({ length: zeros }, (_, i) => routed(`z${i}`, [at(0, 0), at(0, 0)])),
        routed('v', [at(50, 0), at(50, 100)]),
      ]
    }
    const shifted = (jumps: ReturnType<typeof computeEdgeJumps>, tx: number, ty: number) =>
      new Map(
        [...jumps].map(([id, hops]) => [id, hops.map((h) => ({ ...h, x: h.x - tx, y: h.y - ty }))]),
      )

    it.each([
      { name: 'a cross translated by 1e16', u: 2, zeros: 1, tx: 1e16, ty: 1e16 },
      // Coordinate over a one-pixel cell past 2^53, where an index loop
      // cannot advance.
      {
        name: 'a cross at 2^60 under a one-pixel cell',
        u: 256,
        zeros: 4000,
        tx: 2 ** 60,
        ty: 2 ** 60,
      },
      // Far out yet clear of overflow: the narrow phase squares an extent.
      { name: 'a cross at 2^500', u: 2 ** 448, zeros: 1, tx: 2 ** 500, ty: -(2 ** 500) },
    ])('hops as at the origin for $name', ({ u, zeros, tx, ty }) => {
      const edges = cross(u, zeros, tx, ty)
      const segments = edges.length
      const { jumps, visits } = jumpsWithinCellBudget(edges, 8 * segments)

      const atOrigin = computeEdgeJumps(cross(u, zeros, 0, 0))
      expect(atOrigin.get('v')).toEqual([{ segment: 0, x: 50 * u, y: 50 * u }])
      expect(shifted(jumps, tx, ty)).toEqual(new Map(atOrigin))
      expect(visits).toBeGreaterThan(0)
    })

    it('still hops where one segment spans the whole double range', () => {
      // Its extent is not finite, so its arithmetic is NaN against any
      // other segment and it can take part in no crossing. The cross near 0
      // must still hop.
      const edges = [
        routed('w', [
          { x: -1.7e308, y: 10 },
          { x: 1.7e308, y: 10 },
        ]),
        routed('h', [
          { x: 0, y: 0 },
          { x: 200, y: 0 },
        ]),
        routed('v', [
          { x: 100, y: -100 },
          { x: 100, y: 100 },
        ]),
      ]
      const { jumps } = jumpsWithinCellBudget(edges, 8 * edges.length)

      expect(new Map(jumps)).toEqual(new Map([['v', [{ segment: 0, x: 100, y: 0 }]]]))
    })

    it('keeps a far outlier from widening every other segment', () => {
      // One edge 1e16 away from a board of crosses near the origin: the
      // board's span is then 1e16 cells, while each cross stays local.
      const crosses = Array.from({ length: 200 }, (_, i) =>
        cross(1, 0, i * 300, 0).map((edge) => ({ ...edge, id: `${edge.id}${i}` })),
      ).flat()
      const edges = [
        routed('far', [
          { x: -1e16, y: -1e16 },
          { x: -1e16 + 100, y: -1e16 },
        ]),
        ...crosses,
      ]
      const segments = edges.length
      narrowTests.count = 0
      const { jumps, visits } = jumpsWithinCellBudget(edges, 64 * segments)

      expect(jumps.size).toBe(200)
      expect(jumps.get('v199')).toEqual([{ segment: 0, x: 199 * 300 + 50, y: 50 }])
      expect(visits / segments).toBeLessThanOrEqual(64)
      // Checking every segment against every other would be 80_000 pairs.
      expect(narrowTests.count / segments).toBeLessThanOrEqual(4)
    })
  })
})
