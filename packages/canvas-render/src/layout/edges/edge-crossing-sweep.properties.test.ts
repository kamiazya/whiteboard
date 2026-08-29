// The sweep-and-prune broad phase must be EXACTLY equal to the full
// pairwise scan — not approximately: the optimizer's lexicographic cost
// comparisons are integer-exact, so a single missed candidate pair changes
// side-choice equilibria. The full double loop over the shared narrow
// phase stays here as the oracle.
import type { CanvasEdge, SpatialNode } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../../test-utils/fast-check.js'
import { buildPairwiseScores, scoreSegmentPair } from './edge-crossing-sweep.js'
import { assignEdgeAnchors, routeEdge } from './spatial-edges.js'

type Point = { readonly x: number; readonly y: number }

/** The O(E^2) oracle: the exact per-pair sum the old matrix build made. */
function oracle(
  paths: readonly (readonly Point[])[],
): Map<number, readonly [number, number, number]> {
  const scores = new Map<number, readonly [number, number, number]>()
  for (let i = 0; i < paths.length; i++) {
    for (let j = i + 1; j < paths.length; j++) {
      let overlap = 0
      let illegible = 0
      let crossings = 0
      const a = paths[i]!
      const b = paths[j]!
      for (let ai = 1; ai < a.length; ai++) {
        for (let bi = 1; bi < b.length; bi++) {
          const [o, il, c] = scoreSegmentPair(a[ai - 1]!, a[ai]!, b[bi - 1]!, b[bi]!)
          overlap += o
          illegible += il
          crossings += c
        }
      }
      scores.set(i * paths.length + j, [overlap, illegible, crossings])
    }
  }
  return scores
}

/** Small field + few nodes so edges share sides (fan-out lanes, collinear
 * corridors) and cross each other — the arrangements that matter. */
const scenarioArbitrary = fc
  .record({
    nodeCount: fc.integer({ min: 3, max: 8 }),
    positions: fc.array(
      fc.record({
        x: fc.integer({ min: 0, max: 60 }).map((n) => n * 10),
        y: fc.integer({ min: 0, max: 60 }).map((n) => n * 10),
        w: fc.integer({ min: 6, max: 20 }).map((n) => n * 10),
        h: fc.integer({ min: 5, max: 12 }).map((n) => n * 10),
      }),
      { minLength: 8, maxLength: 8 },
    ),
    pairs: fc.array(fc.record({ from: fc.nat({ max: 7 }), to: fc.nat({ max: 7 }) }), {
      minLength: 2,
      maxLength: 24,
    }),
    style: fc.constantFrom('straight' as const, 'orthogonal' as const, 'curved' as const),
  })
  .map(({ nodeCount, positions, pairs, style }) => {
    const nodes: SpatialNode[] = positions.slice(0, nodeCount).map((p, i) => ({
      id: `n${i}`,
      type: 'text',
      x: p.x,
      y: p.y,
      width: p.w,
      height: p.h,
      text: '',
    }))
    const edges: CanvasEdge[] = pairs
      .map((p, i) => ({
        id: `e${i}`,
        fromNode: `n${p.from % nodeCount}`,
        toNode: `n${p.to % nodeCount}`,
      }))
      .filter((e) => e.fromNode !== e.toNode)
    return { nodes, edges, style }
  })

/** Routed paths exactly as optimizeSideChoices consumes them. */
function routedPaths(
  nodes: readonly SpatialNode[],
  edges: readonly CanvasEdge[],
  style: 'straight' | 'orthogonal' | 'curved',
): (readonly Point[])[] {
  const anchors = assignEdgeAnchors(nodes, edges, style)
  return edges.map((e) => routeEdge(nodes, e, style, anchors.get(e.id)).path)
}

/**
 * Generator-density accounting: a sweep property whose inputs never reach
 * collinear overlaps or shared endpoints passes vacuously.
 *
 * PER PROPERTY, not in aggregate. One shared set of counters was satisfied
 * by whichever domain happened to reach a case, so a domain that stopped
 * reaching it entirely stayed green behind the other one — measured, the
 * routed domain saw a collinear overlap in 4 of 112 runs against the raw
 * domain's own, and nothing would have said so if it had been 0.
 */
type DensityCounts = { overlap: number; crossing: number; sharedEndpoint: number; pairs: number }
const routedDensity: DensityCounts = { overlap: 0, crossing: 0, sharedEndpoint: 0, pairs: 0 }
const rawDensity: DensityCounts = { overlap: 0, crossing: 0, sharedEndpoint: 0, pairs: 0 }

/** Raw grid-snapped polylines: denser in the sweep's degenerate cases
 * (collinear corridors, shared endpoints, vertical stacks, zero-length
 * segments) than anything the router emits. Five lines per axis rather than
 * nine, because this domain is the only one answering for those cases and
 * the count is what it is judged on: the same jitter over fewer distinct
 * lines measured 41 collinear-overlap pairs and 94 shared endpoints against
 * 17 and 31 on the wider grid. */
const rawPathsArbitrary = fc.array(
  fc
    .array(
      fc.record({
        // Grid coordinates plus optional sub-quantum jitter (< 0.25px):
        // q(n) = round(4n) rates jittered coordinates equal to their grid
        // neighbours, which is exactly the class the broad phase's bbox
        // slack exists for — a generator without it can never catch a
        // dropped-slack regression.
        x: fc
          .tuple(fc.integer({ min: 0, max: 4 }), fc.constantFrom(0, 0, 0.1, 0.24))
          .map(([n, j]) => n * 5 + j),
        y: fc
          .tuple(fc.integer({ min: 0, max: 4 }), fc.constantFrom(0, 0, 0.1, 0.24))
          .map(([n, j]) => n * 5 + j),
      }),
      { minLength: 2, maxLength: 5 },
    )
    .map((points) => points as readonly Point[]),
  { minLength: 2, maxLength: 10 },
)

describe('edge-crossing sweep — differential equality with the pairwise oracle', () => {
  // Fewer runs than the shared default, and the reason is measured rather than
  // guessed: this property routes through the real `assignEdgeAnchors`, so the
  // aligned second run that landed with the side-choice repair made each case
  // 53% more expensive (1405ms -> 2150ms for 200 runs). The per-test budget is
  // 5s, which left no headroom once every project runs in parallel — the test
  // then times out, reports a fast-check seed, and reads like a property
  // failure when nothing has failed at all.
  //
  // Trimming THIS property costs least: its distinct value is realism (paths
  // exactly as the optimizer emits them), while the degenerate density the
  // sweep is most likely to get wrong — collinear corridors, shared endpoints,
  // zero-length segments — is covered at full strength by the raw-polyline
  // property below, which is 20x cheaper.
  fcTest.prop([scenarioArbitrary], withDefaults({ numRuns: 120 }))(
    'the sweep matrix equals the full O(E^2) scan for every pair',
    ({ nodes, edges, style }) => {
      if (edges.length < 2) return
      const paths = routedPaths(nodes, edges, style)
      const expected = oracle(paths)
      const actual = buildPairwiseScores(paths)
      for (const [key, exp] of expected) {
        const got = actual.get(key) ?? [0, 0, 0]
        expect(got).toEqual(exp)
        routedDensity.pairs++
        if (exp[0] > 0) routedDensity.overlap++
        if (exp[2] > 0) routedDensity.crossing++
      }
      // The sweep must not invent pairs the oracle scored zero either.
      for (const [key, got] of actual) {
        const exp = expected.get(key) ?? [0, 0, 0]
        expect(got).toEqual(exp)
      }
      const endpoints = new Set<string>()
      for (const path of paths) {
        const first = path[0]
        if (first === undefined) continue
        const k = `${first.x},${first.y}`
        if (endpoints.has(k)) routedDensity.sharedEndpoint++
        endpoints.add(k)
      }
    },
  )

  fcTest.prop([rawPathsArbitrary], withDefaults())(
    'raw grid polylines: dense collinear/shared-endpoint arrangements agree too',
    (paths) => {
      const expected = oracle(paths)
      const actual = buildPairwiseScores(paths)
      for (const [key, exp] of expected) {
        expect(actual.get(key) ?? [0, 0, 0]).toEqual(exp)
        rawDensity.pairs++
        if (exp[0] > 0) rawDensity.overlap++
        if (exp[2] > 0) rawDensity.crossing++
      }
      for (const [key, got] of actual) {
        expect(got).toEqual(expected.get(key) ?? [0, 0, 0])
      }
      const endpoints = new Set<string>()
      for (const path of paths) {
        for (const p of [path[0]!, path[path.length - 1]!]) {
          const k = `${p.x},${p.y}`
          if (endpoints.has(k)) rawDensity.sharedEndpoint++
          endpoints.add(k)
        }
      }
    },
  )

  it('each generator actually reaches the arrangements it is responsible for', () => {
    // The two domains answer for different things, which is why the counts
    // are read separately rather than summed. The raw domain is the one
    // built for degenerate density, so it answers for all three cases; the
    // routed domain's distinct value is realism — real anchors, real
    // fan-out — and it answers for crossings and for having scored a pair
    // at all. Asserting a collinear overlap out of the ROUTED domain would
    // be asserting on 3-4% of its runs, which is a flake, not a guard.
    expect({
      rawOverlap: rawDensity.overlap > 0,
      rawCrossing: rawDensity.crossing > 0,
      rawSharedEndpoint: rawDensity.sharedEndpoint > 0,
      routedCrossing: routedDensity.crossing > 0,
      routedScoredPairs: routedDensity.pairs > 0,
    }).toEqual({
      rawOverlap: true,
      rawCrossing: true,
      rawSharedEndpoint: true,
      routedCrossing: true,
      routedScoredPairs: true,
    })
  })

  it('is deterministic: identical inputs produce deeply-equal matrices', () => {
    const nodes: SpatialNode[] = [
      { id: 'a', type: 'text', x: 0, y: 0, width: 100, height: 60, text: '' },
      { id: 'b', type: 'text', x: 300, y: 0, width: 100, height: 60, text: '' },
      { id: 'c', type: 'text', x: 150, y: 200, width: 100, height: 60, text: '' },
    ]
    const edges: CanvasEdge[] = [
      { id: 'e0', fromNode: 'a', toNode: 'b' },
      { id: 'e1', fromNode: 'c', toNode: 'a' },
      { id: 'e2', fromNode: 'c', toNode: 'b' },
    ]
    const paths = routedPaths(nodes, edges, 'orthogonal')
    expect(buildPairwiseScores(paths)).toEqual(buildPairwiseScores(paths))
  })
})
