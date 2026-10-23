// Two corners on one point draw a plus sign. No pair of their segments
// crosses properly and a corner has no straight run to hop along, so before
// they were priced the optimizer saw nothing wrong and a tidy board drew the
// look of a crossing with no hop.
import { describe, expect, it } from 'vitest'
import { designerBoard } from '../../test-utils/routing-corpus.js'
import { buildPairwiseScores, sharedCorners } from './edge-crossing-sweep.js'
import { routeEdge } from './edge-router.js'
import { assignEdgeAnchors } from './spatial-edges.js'

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

describe('corners that share a point', () => {
  it('count once for the pair', () => {
    expect(sharedCorners(kissing[0], kissing[1])).toBe(1)
  })

  it('are priced as the crossing they read as, by the sweep', () => {
    const scores = buildPairwiseScores(kissing)
    expect(scores.get(0 * 2 + 1)).toEqual([0, 0, 1])
  })

  it('are not found where two paths merely end on one anchor', () => {
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
    expect(buildPairwiseScores(converging).size).toBe(0)
  })

  it('count once however often one path revisits the corner', () => {
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
