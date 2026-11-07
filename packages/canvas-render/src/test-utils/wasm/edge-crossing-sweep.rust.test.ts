import { afterAllFloor } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect } from 'vitest'
import { buildPairwiseScores, sharedCorners } from '../../layout/edges/edge-crossing-sweep.js'
import type { Point } from '../../layout/edges/edge-geometry.js'
import { fc, fcTest, withDefaults } from '../fast-check.js'
import { firstDifference, path } from './edge-arbitraries.js'
import { built, requireWasm } from './glue.js'

/**
 * edge-crossing-sweep.ts against its Rust port through the wasm artifact
 * (ADR-0054 step 5, QR-21 layer 2): every pair's summed overlap, illegible
 * and crossing counts in Map order, the pairs account the sweep spends,
 * and `sharedCorners` of every ordered pair of paths.
 */

/**
 * A path's corners reused by another, so two paths turn at one point (the
 * plus sign `sharedCorners` prices) and run collinear along a shared lane.
 */
const borrowing = (paths: Point[][]) =>
  fc.tuple(fc.nat(), fc.nat(), fc.constantFrom('corner', 'lane')).map(([from, at, kind]) => {
    const source = paths[from % paths.length] as Point[]
    const p = source[at % source.length] as Point
    return kind === 'corner'
      ? [{ x: p.x - 30, y: p.y }, p, { x: p.x, y: p.y + 30 }]
      : [
          { x: p.x - 60, y: p.y },
          { x: p.x + 60, y: p.y },
        ]
  })

const drawn = fc.array(path, { minLength: 1, maxLength: 7 }).chain((paths) =>
  fc.record({
    paths: fc
      .array(borrowing(paths), { maxLength: 3 })
      .map((extra) => [...paths, ...extra] as Point[][]),
    // Unbounded, cut short, or ample.
    pairs: fc.oneof(
      fc.constant(undefined),
      fc.integer({ min: 0, max: 40 }),
      fc.constant(64_000_000),
    ),
  }),
)

const reach = {
  built: 0,
  refused: 0,
  overlap: 0,
  illegible: 0,
  crossing: 0,
  shared: 0,
}

describe.runIf(built)('edge-crossing-sweep.ts and its Rust port score the same pairs', () => {
  fcTest.prop([drawn], withDefaults())('pair scores, spend and shared corners', (d) => {
    const budget = d.pairs === undefined ? undefined : { pairs: d.pairs }
    const scores =
      budget === undefined ? buildPairwiseScores(d.paths) : buildPairwiseScores(d.paths, budget)
    const shared = d.paths.flatMap((a) => d.paths.map((b) => sharedCorners(a, b)))
    const input = Float64Array.from([
      d.paths.length,
      ...d.paths.flatMap((p) => [p.length, ...p.flatMap((v) => [v.x, v.y])]),
      ...(d.pairs === undefined ? [0, 0] : [1, d.pairs]),
    ])
    const out = requireWasm().edge_pairwise_scores(input)
    const ts = [
      budget?.pairs ?? 0,
      ...(scores === undefined
        ? [0, 0]
        : [1, scores.size, ...[...scores].flatMap(([key, triple]) => [key, ...triple])]),
      ...shared,
    ]
    expect(firstDifference(ts, out)).toBeUndefined()

    if (scores === undefined) reach.refused += 1
    else reach.built += 1
    for (const [o, i, c] of scores?.values() ?? []) {
      if (o > 0) reach.overlap += 1
      if (i > 0) reach.illegible += 1
      if (c > 0) reach.crossing += 1
    }
    if (shared.some((n) => n > 0)) reach.shared += 1
  })

  afterAllFloor(['pair scores, spend and shared corners'], () => {
    // About half the lowest of five measured runs (built 147, refused 44,
    // overlap 107, illegible 65, crossing 385, shared 194).
    const floors = {
      built: 73,
      refused: 22,
      overlap: 53,
      illegible: 32,
      crossing: 190,
      shared: 97,
    }
    for (const [kind, floor] of Object.entries(floors)) {
      expect(reach[kind as keyof typeof reach], kind).toBeGreaterThanOrEqual(floor)
    }
  })
})
