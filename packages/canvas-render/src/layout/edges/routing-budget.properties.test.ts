// The routing budget may only ever REFUSE work; it must never change an
// answer it could afford. So the claim is stated against the work a layout
// actually does: route a board with an account large enough to never refuse,
// read back what it spent, and route it again with an account holding exactly
// that much. Every check refuses only work the account cannot cover, so the
// second layout must be identical to the first, which refuses nothing and so
// is what the router did before any budget existed — and so must a layout
// under the default account.

import type { CanvasEdge, EdgeRoutingStyle, SpatialNode } from '@kamiazya/whiteboard-model'
import { endNode } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../../test-utils/fast-check.js'
import { routeEdge } from './edge-router.js'
import { initialSideChoices } from './edge-sides.js'
import type { RoutingBudget } from './routing-budget.js'
import { assignEdgeAnchors } from './spatial-edges.js'

const AMPLE = 1e12

/**
 * Crowded boxes, so the enumerated candidates fail and the grid router runs,
 * and edges that sometimes carry bends, so the search scores segment pairs
 * of paths it did not route.
 */
const boardArbitrary = fc
  .record({
    boxes: fc.array(
      fc.record({
        x: fc.integer({ min: 0, max: 40 }).map((n) => n * 15),
        y: fc.integer({ min: 0, max: 40 }).map((n) => n * 15),
        w: fc.integer({ min: 4, max: 14 }).map((n) => n * 15),
        h: fc.integer({ min: 3, max: 10 }).map((n) => n * 15),
      }),
      { minLength: 4, maxLength: 12 },
    ),
    links: fc.array(
      fc.record({
        from: fc.nat({ max: 11 }),
        to: fc.nat({ max: 11 }),
        bends: fc.oneof(
          fc.constant<{ x: number; y: number }[]>([]),
          fc.array(
            fc.record({
              x: fc.integer({ min: 0, max: 60 }).map((n) => n * 10),
              y: fc.integer({ min: 0, max: 60 }).map((n) => n * 10),
            }),
            { minLength: 1, maxLength: 6 },
          ),
        ),
      }),
      { minLength: 1, maxLength: 16 },
    ),
    style: fc.constantFrom<EdgeRoutingStyle>('orthogonal', 'orthogonal', 'curved', 'straight'),
  })
  .map(({ boxes, links, style }) => {
    const nodes: SpatialNode[] = boxes.map((b, i) =>
      textNode({ id: `n${i}`, x: b.x, y: b.y, width: b.w, height: b.h, text: '' }),
    )
    const edges: CanvasEdge[] = links
      .map((l, i) => ({
        id: `e${i}`,
        from: { node: `n${l.from % nodes.length}` },
        to: { node: `n${l.to % nodes.length}` },
        ...(l.bends.length > 0 ? { bends: l.bends } : {}),
      }))
      .filter((e) => endNode(e.from) !== endNode(e.to))
    return { nodes, edges, style }
  })

/** The anchors and drawn paths of one layout, spending from `budget` throughout. */
function layout(
  nodes: readonly SpatialNode[],
  edges: readonly CanvasEdge[],
  style: EdgeRoutingStyle,
  budget?: RoutingBudget,
) {
  const anchors =
    budget === undefined
      ? assignEdgeAnchors(nodes, edges, style)
      : assignEdgeAnchors(nodes, edges, style, undefined, budget)
  const paths = edges.map(
    (e) => routeEdge(nodes, e, style, anchors.get(e.id), undefined, budget).path,
  )
  return { anchors, paths }
}

const reached = { grid: 0, pairs: 0, runs: 0 }

describe('routing budget', () => {
  fcTest.prop([boardArbitrary], withDefaults({ numRuns: 80 }))(
    'an account holding exactly what a layout spends lays it out unchanged',
    ({ nodes, edges, style }) => {
      const measured = { grid: AMPLE, pairs: AMPLE }
      const ample = layout(nodes, edges, style, measured)
      const spent = { grid: AMPLE - measured.grid, pairs: AMPLE - measured.pairs }

      const exact = { ...spent }
      expect(layout(nodes, edges, style, exact)).toEqual(ample)
      expect(exact).toEqual({ grid: 0, pairs: 0 })
      expect(layout(nodes, edges, style)).toEqual(ample)

      reached.runs++
      if (spent.grid > 0) reached.grid++
      if (spent.pairs > 0) reached.pairs++
    },
  )

  it('the property reaches boards that spend on both accounts', () => {
    // Measured at 80 runs: the grid router spends on 38 of the boards and
    // the pair scoring on 73; a floor well under both
    // still fails a generator that stopped crowding its boxes.
    expect(reached.runs).toBeGreaterThan(0)
    expect(reached.grid / reached.runs).toBeGreaterThan(0.1)
    expect(reached.pairs / reached.runs).toBeGreaterThan(0.5)
  })

  it('adopts no trial it could price only in part', () => {
    // Two edges whose search, unbounded, re-sides both. With an account of
    // 14 segment pairs the pairwise builds are paid for and every trial runs
    // out part-way through its pairs; a trial summed over only the pairs it
    // could afford keeps the stale price of the rest, and on this board that
    // partial sum reads as an improvement and re-sides the edges.
    const nodes = [
      [600, 540, 165, 45],
      [525, 540, 165, 135],
      [30, 585, 60, 120],
      [60, 30, 75, 75],
    ].map(([x, y, width, height], i) =>
      textNode({ id: `n${i}`, x: x!, y: y!, width: width!, height: height!, text: '' }),
    )
    const edges: CanvasEdge[] = [
      { id: 'e0', from: { node: 'n3' }, to: { node: 'n1' } },
      { id: 'e1', from: { node: 'n2' }, to: { node: 'n0' } },
    ]
    const sides = (pairs: number) =>
      [...assignEdgeAnchors(nodes, edges, 'orthogonal', undefined, { grid: AMPLE, pairs })].map(
        ([id, a]) => [id, a.fromSide, a.toSide],
      )
    // The subject is present: given the budget, the search does re-side.
    expect(sides(AMPLE)).not.toEqual(sides(0))
    expect(sides(14)).toEqual(sides(0))
  })

  it('keeps the first guess when the account cannot cover the pairwise build', () => {
    // A build refused leaves no prices for a trial to be compared against,
    // so a trial priced on its own edges' terms alone would read as an
    // improvement here and re-side `e2`.
    const nodes = [
      [480, 165, 150, 45],
      [255, 255, 165, 45],
      [495, 390, 210, 45],
      [480, 105, 180, 135],
    ].map(([x, y, width, height], i) =>
      textNode({ id: `n${i}`, x: x!, y: y!, width: width!, height: height!, text: '' }),
    )
    const edges: CanvasEdge[] = [
      { id: 'e0', from: { node: 'n0' }, to: { node: 'n2' } },
      { id: 'e1', from: { node: 'n0' }, to: { node: 'n1' } },
      { id: 'e2', from: { node: 'n0' }, to: { node: 'n3' } },
    ]
    const sides = (pairs: number) =>
      [...assignEdgeAnchors(nodes, edges, 'orthogonal', undefined, { grid: AMPLE, pairs })].map(
        ([id, a]) => [id, a.fromSide, a.toSide],
      )
    const firstGuess = [...initialSideChoices(nodes, edges)].map(([id, p]) => [
      id,
      p.fromSide,
      p.toSide,
    ])
    expect(sides(AMPLE)).not.toEqual(firstGuess)
    expect(sides(0)).toEqual(firstGuess)
  })
})
