// Edge routing is the layout budget: `assignEdgeAnchors` runs a side-choice
// search that re-routes and re-scores the edge set many times over, and it
// is the only part of layout whose cost grows with the SQUARE of the canvas.
// Run with `pnpm bench`.
//
// The two sizes are chosen to separate the costs. 40n/40e is a sparse canvas
// where the search settles quickly; 60n/200e is dense enough that the
// optimizer keeps working, which is where every regression has shown up.
//
// Numbers are machine-specific — compare a before/after on the SAME machine
// in one sitting, never a committed figure against a fresh run.
import type { CanvasEdge, SpatialNode } from '@kamiazya/whiteboard-canvas-model'
import { bench, describe } from 'vitest'
import { assignEdgeAnchors, routeEdge } from './spatial-edges.js'

/**
 * A regular grid of boxes wired by a stride that guarantees long, crossing
 * edges rather than neighbour-to-neighbour hops — the arrangement that keeps
 * the optimizer busy. Deterministic, so two runs compare like for like.
 */
function gridCanvas(nodeCount: number, edgeCount: number) {
  const nodes: SpatialNode[] = Array.from({ length: nodeCount }, (_, i) => ({
    id: `n${i}`,
    type: 'text',
    x: (i % 8) * 260,
    y: Math.floor(i / 8) * 180,
    width: 200,
    height: 120,
    text: `n${i}`,
  }))
  const edges: CanvasEdge[] = Array.from({ length: edgeCount }, (_, i) => ({
    id: `e${i}`,
    fromNode: `n${i % nodeCount}`,
    toNode: `n${(i * 7 + 3) % nodeCount}`,
  })).filter((e) => e.fromNode !== e.toNode)
  return { nodes, edges }
}

const sparse = gridCanvas(40, 40)
const dense = gridCanvas(60, 200)

describe('side-choice search', () => {
  bench('assignEdgeAnchors 40 nodes / 40 edges', () => {
    assignEdgeAnchors(sparse.nodes, sparse.edges, 'orthogonal')
  })

  bench('assignEdgeAnchors 60 nodes / 200 edges', () => {
    assignEdgeAnchors(dense.nodes, dense.edges, 'orthogonal')
  })
})

// The primitives the search calls, so a regression can be attributed rather
// than guessed at: if the search slows down but these did not, the cost is in
// how many times it calls them.
describe('routing primitives', () => {
  const denseAnchors = assignEdgeAnchors(dense.nodes, dense.edges, 'orthogonal')

  bench('routeEdge over 200 edges, orthogonal', () => {
    for (const edge of dense.edges) {
      routeEdge(dense.nodes, edge, 'orthogonal', denseAnchors.get(edge.id))
    }
  })

  bench('routeEdge over 200 edges, straight', () => {
    for (const edge of dense.edges) {
      routeEdge(dense.nodes, edge, 'straight', denseAnchors.get(edge.id))
    }
  })
})
