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
import type { CanvasEdge, SpatialNode } from '@kamiazya/whiteboard-model'
import { bench, describe } from 'vitest'
import { clusteredLayout } from '../test-utils/routing-corpus.js'
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

// The stride canvas above is the WORST case for spatial pruning: every edge
// spans the whole layout, so 55% of edge pairs survive a bounding-box test.
// A real document clusters, and so do its edges — measured on these two, 5%
// and 4%. Both shapes belong here: the stride canvas bounds the damage when
// pruning cannot help, and these bound the common case, where nearly all of
// the pair loop's work is rejecting edges that could never have interacted.
const clustered = clusteredLayout({ clusters: 12, nodesPerCluster: 12, edgesPerCluster: 16 })
// Deliberately past CROSSING_OPT_MAX_EDGES, where side-choice optimization
// is skipped entirely today: this is the size an AI-authored canvas reaches,
// and the number to watch when raising that gate.
const clusteredLarge = clusteredLayout({ clusters: 24, nodesPerCluster: 12, edgesPerCluster: 16 })

describe('side-choice search', () => {
  bench('assignEdgeAnchors 40 nodes / 40 edges', () => {
    assignEdgeAnchors(sparse.nodes, sparse.edges, 'orthogonal')
  })

  bench('assignEdgeAnchors 60 nodes / 200 edges', () => {
    assignEdgeAnchors(dense.nodes, dense.edges, 'orthogonal')
  })

  bench('assignEdgeAnchors clustered 144 nodes / 165 edges', () => {
    assignEdgeAnchors(clustered.nodes, clustered.edges, 'orthogonal')
  })

  bench('assignEdgeAnchors clustered 288 nodes / 345 edges (over the opt gate)', () => {
    assignEdgeAnchors(clusteredLarge.nodes, clusteredLarge.edges, 'orthogonal')
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
