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

const narrowTests = vi.hoisted(() => ({ count: 0 }))

vi.mock('./segment-intersection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./segment-intersection.js')>()
  return {
    ...actual,
    segmentIntersection: (...args: Parameters<typeof actual.segmentIntersection>) => {
      narrowTests.count++
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

describe('computeEdgeJumps cost', () => {
  it('tests a bounded number of segment pairs per segment when edges keep apart', () => {
    // 1000 staircases of 64 bends, each in its own 2000px cell, and one short
    // later edge per cell crossing its staircase's first step: 2000 edges,
    // 66_000 segments, exactly one real crossing per cell.
    const cells = 1000
    const edges: ResolvedEdgeNode[] = []
    for (let i = 0; i < cells; i++) {
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
    const segments = edges.reduce((n, e) => n + e.path.length - 1, 0)

    narrowTests.count = 0
    const { jumps, visits } = jumpsWithinCellBudget(edges, 64 * segments)

    // The subject is present: every crosser still hops its staircase, and
    // nothing else hops at all.
    expect(jumps.size).toBe(cells)
    expect(jumps.get('c0')).toEqual([{ segment: 0, x: STEP_PX / 2, y: 0 }])
    expect(jumps.get('c999')).toEqual([{ segment: 0, x: 39 * 2000 + STEP_PX / 2, y: 24 * 2000 }])
    expect(narrowTests.count).toBeGreaterThanOrEqual(cells)
    // All pairs is about segments² / 2 — 2.2e9 here; 3_268 per segment at a
    // tenth of this size. Measured 1_950 in all behind the grid.
    expect(narrowTests.count / segments).toBeLessThanOrEqual(0.1)
    expect(visits).toBeGreaterThan(segments)
    // Each segment reads its cells twice, to find candidates and to enter
    // itself. Measured 4.17 per segment.
    expect(visits / segments).toBeLessThanOrEqual(8)
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
})
