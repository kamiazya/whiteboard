// A facing opposing pair only counts as a zero-bend candidate when the two
// sides genuinely share a lane wide enough to host an anchor away from the
// corners. Nodes whose spans merely graze (a sliver of overlap) cannot
// realize the promised straight segment — the anchors land outside the
// sliver and the route degrades to a shallow near-horizontal diagonal —
// so they must take the one-bend L through the perpendicular sides instead.
import type { CanvasEdge, SpatialNode } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { assignEdgeAnchors, routeEdge } from './spatial-edges.js'

// The reported triangle: A above B (fully aligned), C to the right and
// vertically between them, overlapping both in x by only 20px.
const NODES: SpatialNode[] = [
  { id: 'A', type: 'text', x: 100, y: 340, width: 200, height: 100, text: '' },
  { id: 'B', type: 'text', x: 100, y: 570, width: 200, height: 100, text: '' },
  { id: 'C', type: 'text', x: 280, y: 460, width: 200, height: 100, text: '' },
]
const EDGES: CanvasEdge[] = [
  { id: 'A-B', fromNode: 'A', toNode: 'B' },
  { id: 'B-C', fromNode: 'B', toNode: 'C' },
  { id: 'A-C', fromNode: 'A', toNode: 'C' },
]

function isAxisAligned(path: readonly { x: number; y: number }[]): boolean {
  return path.every((p, i) => i === 0 || p.x === path[i - 1]!.x || p.y === path[i - 1]!.y)
}

describe('facing pairs with a sliver of span overlap', () => {
  it('route through the perpendicular L, not the unhostable facing lane', () => {
    const anchors = assignEdgeAnchors(NODES, EDGES, 'straight')
    const ac = anchors.get('A-C')
    expect([ac?.fromSide, ac?.toSide]).toEqual(['right', 'top'])
    const bc = anchors.get('B-C')
    expect([bc?.fromSide, bc?.toSide]).toEqual(['right', 'bottom'])
    // The genuinely-aligned pair keeps its zero-bend vertical.
    const ab = anchors.get('A-B')
    expect([ab?.fromSide, ab?.toSide]).toEqual(['bottom', 'top'])
    expect(ab?.from?.x).toBeDefined()
    expect(ab?.from?.x).toBe(ab?.to?.x)
  })

  it('orthogonal style realizes the L as a fully rectilinear route', () => {
    const anchors = assignEdgeAnchors(NODES, EDGES, 'orthogonal')
    for (const edge of EDGES) {
      const routed = routeEdge(NODES, edge, 'orthogonal', anchors.get(edge.id))
      expect(isAxisAligned(routed.path)).toBe(true)
    }
  })

  it('straight style draws the L pair as one direct segment, not a stub-diagonal-stub', () => {
    const anchors = assignEdgeAnchors(NODES, EDGES, 'straight')
    const routed = routeEdge(NODES, EDGES[2]!, 'straight', anchors.get('A-C'))
    expect(routed.path.length).toBe(2)
  })
})
