// The line-jump broad phase may only PRUNE: under the hop caps, the hops it
// produces must equal those of the all-pairs scan it replaced. The oracle
// shares the narrow phase (`segmentIntersection`) on purpose — the subject
// here is which pairs reach it, and the narrow phase's own branches are
// pinned by the example tests in edge-jumps.test.ts.

import { afterAllFloor } from '@kamiazya/whiteboard-model/test-utils'
import type { EdgeJumpPoint, ResolvedEdgeNode } from '@kamiazya/whiteboard-scene'
import { describe, expect } from 'vitest'
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
const edgesArb = fc
  .array(fc.array(pointArb, { minLength: 2, maxLength: 8 }), { minLength: 2, maxLength: 10 })
  .map((paths) =>
    paths.map(
      (path, i): ResolvedEdgeNode => ({
        kind: 'edge',
        id: `e${i}`,
        path,
        fromSide: 'right',
        toSide: 'left',
        fromEnd: 'none',
        toEnd: 'arrow',
      }),
    ),
  )

const reach = { boards: 0, withHops: 0 }

describe('computeEdgeJumps broad phase', () => {
  fcTest.prop([edgesArb], withDefaults({ numRuns: 400 }))(
    'hops exactly where the all-pairs scan does',
    (edges) => {
      reach.boards++
      const expected = oracle(edges)
      if (expected.size > 0) reach.withHops++
      expect(new Map(computeEdgeJumps(edges))).toEqual(expected)
    },
  )

  afterAllFloor(['hops exactly where the all-pairs scan does'], () => {
    // The generator reaches boards that hop, so equality is not vacuous.
    expect(reach.withHops / reach.boards).toBeGreaterThan(0.8)
  })
})
