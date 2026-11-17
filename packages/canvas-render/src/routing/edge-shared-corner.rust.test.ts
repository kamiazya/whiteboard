// Two corners on one point draw a plus sign. No pair of their segments
// crosses properly and a corner has no straight run to hop along, so before
// they were priced the optimizer saw nothing wrong and a tidy board drew the
// look of a crossing with no hop.
import { describe, expect, it } from 'vitest'
import type { Point } from '../generated/geometry.zod.js'
import { designerBoard } from '../test-utils/routing-corpus.js'
import { routeEdge } from '../test-utils/wasm/edge-router.js'
import { assignEdgeAnchors } from '../test-utils/wasm/spatial-edges.js'

/**
 * Interior corners `a` and `b` share, each of `a`'s counted once however often
 * it revisits it, on the cost model's quarter-pixel grid. Written here from the
 * definition, so the scoreboard does not judge the core by its own pricing.
 */
function sharedCorners(a: readonly Point[], b: readonly Point[]): number {
  const key = (p: Point) => `${Math.round(p.x * 4)},${Math.round(p.y * 4)}`
  const theirs = new Set(b.slice(1, -1).map(key))
  return new Set(
    a
      .slice(1, -1)
      .map(key)
      .filter((k) => theirs.has(k)),
  ).size
}

// The scoreboard below asserts a sum of zero, which a helper that never counts
// would also give. These pin that the helper does count a kiss, and only one.
const kissing = [
  [
    { x: 0, y: 50 },
    { x: 50, y: 50 },
    { x: 50, y: 0 },
  ],
  [
    { x: 100, y: 50 },
    { x: 50, y: 50 },
    { x: 50, y: 100 },
  ],
] as const

describe('the shared-corner count the scoreboard is judged by', () => {
  it('counts two corners on one point once for the pair', () => {
    expect(sharedCorners(kissing[0], kissing[1])).toBe(1)
  })

  it('finds none where two paths merely end on one anchor', () => {
    const converging = [
      [
        { x: 0, y: 50 },
        { x: 50, y: 50 },
      ],
      [
        { x: 50, y: 0 },
        { x: 50, y: 50 },
      ],
    ] as const
    expect(sharedCorners(converging[0], converging[1])).toBe(0)
  })

  it('counts a corner once however often one path revisits it', () => {
    const revisiting = [
      { x: 0, y: 50 },
      { x: 50, y: 50 },
      { x: 50, y: 90 },
      { x: 20, y: 90 },
      { x: 20, y: 50 },
      { x: 50, y: 50 },
      { x: 50, y: 0 },
    ]
    expect(sharedCorners(revisiting, kissing[1])).toBe(1)
  })
})

describe('the optimizer leaves a corner kiss when it can', () => {
  it('draws the service board without two detours bending at one point', () => {
    const board = designerBoard()
    const anchors = assignEdgeAnchors(board.nodes, board.edges, 'orthogonal')
    const paths = board.edges.map(
      (edge) => routeEdge(board.nodes, edge, 'orthogonal', anchors.get(edge.id)).path,
    )
    const shared = paths.flatMap((a, i) => paths.slice(i + 1).map((b) => sharedCorners(a, b)))
    expect(shared.reduce((sum, n) => sum + n, 0)).toBe(0)
  })
})
