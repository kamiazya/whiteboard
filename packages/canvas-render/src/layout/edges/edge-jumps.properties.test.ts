// The line-jump broad phase may only PRUNE: under the hop caps, the hops it
// produces must equal those of the all-pairs scan it replaced. The oracle
// shares the narrow phase (`segmentIntersection`) on purpose — the subject
// here is which pairs reach it, and the narrow phase's own branches are
// pinned by the example tests in edge-jumps.test.ts.

import { afterAllFloor } from '@kamiazya/whiteboard-model/test-utils'
import type { EdgeJumpPoint, ResolvedEdgeNode } from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../../test-utils/fast-check.js'
import { computeEdgeJumps, EDGE_JUMP_RADIUS_PX } from './edge-jumps.js'
import { segmentIntersection } from './segment-intersection.js'

type Point = { readonly x: number; readonly y: number }

/** The all-pairs scan, every later segment against every earlier one. */
function oracle(edges: readonly ResolvedEdgeNode[]): Map<string, EdgeJumpPoint[]> {
  const result = new Map<string, EdgeJumpPoint[]>()
  for (let i = 1; i < edges.length; i++) {
    const later = edges[i]!
    const jumps: EdgeJumpPoint[] = []
    for (let seg = 0; seg < later.path.length - 1; seg++) {
      const a1 = later.path[seg]!
      const a2 = later.path[seg + 1]!
      const len = Math.hypot(a2.x - a1.x, a2.y - a1.y)
      const hits: { point: Point; t: number }[] = []
      for (const earlier of edges.slice(0, i)) {
        for (let k = 0; k < earlier.path.length - 1; k++) {
          const hit = segmentIntersection(a1, a2, earlier.path[k]!, earlier.path[k + 1]!)
          if (hit === undefined) continue
          hits.push({ point: hit, t: len === 0 ? 0 : Math.hypot(hit.x - a1.x, hit.y - a1.y) / len })
        }
      }
      hits.sort((p, q) => p.t - q.t)
      let lastT = Number.NEGATIVE_INFINITY
      for (const { point, t } of hits) {
        if ((t - lastT) * len < 2 * EDGE_JUMP_RADIUS_PX) continue
        lastT = t
        jumps.push({ segment: seg, x: point.x, y: point.y })
      }
    }
    if (jumps.length > 0) result.set(later.id, jumps)
  }
  return result
}

// Mixed scales in one board, so the grid's cell (the mean segment extent)
// is far from many segments' own length; diagonals, so a segment crosses
// cells along a slope; fractional coordinates, so meeting points fall off
// the cell lines as well as on them.
const coordinate = fc.oneof(
  fc.integer({ min: 0, max: 400 }),
  fc.double({ min: 0, max: 400, noNaN: true }),
  fc.integer({ min: 0, max: 4000 }),
)
const pointArb = fc.record({ x: coordinate, y: coordinate })
// Coordinates are unbounded finite numbers, so a board may sit anywhere:
// translated far from 0 (where a cell index taken from the coordinate
// itself outgrows its pad), or with one edge far from the rest (where the
// board's span dwarfs its cell). Rounding at those magnitudes is shared by
// the oracle, which reads the same translated points.
const far = fc.constantFrom(1e9, 1e16, -1e16, 2 ** 60, -(2 ** 60), 3e150, -1e300)
const translationArb = fc.oneof(
  { weight: 3, arbitrary: fc.constant({ x: 0, y: 0 }) },
  { weight: 1, arbitrary: fc.record({ x: far, y: far }) },
)
const outlierArb = fc.oneof(
  { weight: 3, arbitrary: fc.constant(null) },
  { weight: 1, arbitrary: fc.record({ x: far, y: far }) },
)
// An edge from inside the board out to a far point, at any place in
// document order: it crosses the board while too far-reaching for the grid,
// so the board's own segments must still find it, and it them.
const spokeArb = fc.oneof(
  { weight: 2, arbitrary: fc.constant(null) },
  {
    weight: 1,
    arbitrary: fc.record({ from: pointArb, to: fc.record({ x: far, y: far }), at: fc.nat() }),
  },
)
// The oracle scans segments; the subject scans straight runs, which differ
// only where a waypoint sits on an axis-aligned line (edge-jumps.test.ts pins
// that case). Dropping such waypoints keeps this property about the broad phase.
const withoutStraightWaypoints = (path: readonly Point[]): Point[] =>
  path.filter((p, i) => {
    const prev = path[i - 1]
    const next = path[i + 1]
    if (prev === undefined || next === undefined) return true
    const forward = (axis: 'x' | 'y') =>
      Math.sign(p[axis] - prev[axis]) * Math.sign(next[axis] - p[axis]) > 0
    const onVertical = prev.x === p.x && p.x === next.x && forward('y')
    const onHorizontal = prev.y === p.y && p.y === next.y && forward('x')
    return !onVertical && !onHorizontal
  })

const edgesArb = fc
  .tuple(
    fc.array(fc.array(pointArb, { minLength: 2, maxLength: 8 }), { minLength: 2, maxLength: 10 }),
    translationArb,
    outlierArb,
    spokeArb,
  )
  .map(([drawn, shift, outlier, spoke]) => {
    const moved = drawn.map((path) => path.map((p) => ({ x: p.x + shift.x, y: p.y + shift.y })))
    const withOutlier =
      outlier === null ? moved : [...moved, [outlier, { x: outlier.x + 100, y: outlier.y + 100 }]]
    if (spoke === null) return withOutlier
    const at = spoke.at % (withOutlier.length + 1)
    const from = { x: spoke.from.x + shift.x, y: spoke.from.y + shift.y }
    return [...withOutlier.slice(0, at), [from, spoke.to], ...withOutlier.slice(at)]
  })
  .map((paths) =>
    paths.map(
      (path, i): ResolvedEdgeNode => ({
        kind: 'edge',
        id: `e${i}`,
        path: withoutStraightWaypoints(path),
        fromSide: 'right',
        toSide: 'left',
        fromEnd: 'none',
        toEnd: 'arrow',
      }),
    ),
  )

const edge = (id: string, path: Point[]): ResolvedEdgeNode => ({
  kind: 'edge',
  id,
  path,
  fromSide: 'right',
  toSide: 'left',
  fromEnd: 'none',
  toEnd: 'arrow',
})

const reach = { boards: 0, withHops: 0, farBoards: 0, farWithHops: 0 }
const isFar = (edges: readonly ResolvedEdgeNode[]) =>
  edges.some((e) => e.path.some((p) => Math.abs(p.x) > 1e8 || Math.abs(p.y) > 1e8))

describe('computeEdgeJumps broad phase', () => {
  fcTest.prop([edgesArb], withDefaults({ numRuns: 400 }))(
    'hops exactly where the all-pairs scan does',
    (edges) => {
      reach.boards++
      const expected = oracle(edges)
      if (expected.size > 0) reach.withHops++
      if (isFar(edges)) {
        reach.farBoards++
        if (expected.size > 0) reach.farWithHops++
      }
      expect(new Map(computeEdgeJumps(edges))).toEqual(expected)
    },
  )

  // e1's first segment crosses e0 twice at e0's corner (55, 0): the two
  // hits have the same `t` but differ in their last bits, so which one
  // survives the spacing rule rests on the order candidates arrive in.
  // e0's two segments sit at different grid levels, so either direction
  // puts the coarser one first in one of the two orders the grid could use.
  const corner = [
    { x: 0.001620334765735976, y: 1029 },
    { x: 55, y: 0 },
    { x: 0, y: 23 },
  ]
  it.each([
    { name: 'coarse segment first', path: corner },
    { name: 'fine segment first', path: [...corner].reverse() },
  ])('keeps the same hop as the scan when two crossings tie, $name', ({ path }) => {
    const edges = [
      edge('e0', path),
      edge('e1', [
        { x: 2651, y: 6.707523425575388e-12 },
        { x: 0, y: 0 },
      ]),
    ]
    expect(new Map(computeEdgeJumps(edges))).toEqual(oracle(edges))
  })

  it('keeps a crossing that lies just past a column line of the grid', () => {
    // Found by drawing coordinates beside the grid's own cell lines: e1
    // crosses e0 where e0's part in one column ends, so a column taken a
    // phase off its true line files that part's rows under its neighbour.
    const edges = [
      edge('e0', [
        { x: 0, y: -609.7832960000001 },
        { x: -391.133184, y: 0 },
      ]),
      edge('e1', [
        { x: -353.783296, y: -88.445824 },
        { x: 0, y: 0 },
      ]),
      edge('e2', [
        { x: -24.445824, y: 0 },
        { x: 0, y: 0 },
      ]),
      edge('e3', [
        { x: 0, y: -24.445824 },
        { x: -24.445824, y: -24.445824 },
      ]),
    ]
    const expected = oracle(edges)
    expect(expected.size).toBeGreaterThan(0)
    expect(new Map(computeEdgeJumps(edges))).toEqual(expected)
  })

  it('keeps the hops of a board beside an outlier 2^60 away', () => {
    // A grid with one origin for the whole board put it at the outlier, so
    // every other coordinate sat 2^60 from it and rounded to 256px there;
    // e2's crossing of e0 then fell between cells.
    const edges = [
      edge('e0', [
        { x: 129, y: 917 },
        { x: 2084, y: 0 },
        { x: 0, y: 203 },
        { x: 0, y: 0 },
      ]),
      edge('e1', [
        { x: 0, y: 0 },
        { x: 2347, y: 0 },
      ]),
      edge('e2', [
        { x: 67, y: 0 },
        { x: 244, y: 2617 },
        { x: 0, y: 0 },
        { x: 0, y: 0 },
      ]),
      edge('e3', [
        { x: -(2 ** 60), y: 1e9 },
        { x: -(2 ** 60) + 100, y: 1e9 + 100 },
      ]),
    ]
    const expected = oracle(edges)
    expect(expected.get('e2')).toHaveLength(3)
    expect(new Map(computeEdgeJumps(edges))).toEqual(expected)
  })

  afterAllFloor(['hops exactly where the all-pairs scan does'], () => {
    // The generator reaches boards that hop, so equality is not vacuous.
    expect(reach.withHops / reach.boards).toBeGreaterThan(0.8)
    // And a share of the boards that hop sit far from 0.
    expect(reach.farBoards / reach.boards).toBeGreaterThan(0.25)
    expect(reach.farWithHops / reach.farBoards).toBeGreaterThan(0.5)
  })
})
