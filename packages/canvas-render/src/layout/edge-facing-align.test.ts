// A facing pair ranked zero-bend promises a straight segment, but anchors
// were placed at per-side fractions and never slid into the shared lane —
// the promise held only when midpoints happened to align (offset stacked
// nodes got a Z in orthogonal, a diagonal in straight, where a clean
// vertical exists).
import type { CanvasEdge, SpatialNode } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { assignEdgeAnchors, routeEdge } from './spatial-edges.js'

describe('facing-pair anchor alignment', () => {
  // Offset stacked nodes: raw x-overlap 50px, inset lane [160,190].
  const NODES: SpatialNode[] = [
    { id: 'A', type: 'text', x: 0, y: 0, width: 200, height: 100, text: '' },
    { id: 'B', type: 'text', x: 150, y: 300, width: 200, height: 100, text: '' },
  ]
  const EDGE: CanvasEdge = { id: 'A-B', fromNode: 'A', toNode: 'B' }

  it('slides both anchors to one coordinate inside the shared lane', () => {
    const anchors = assignEdgeAnchors(NODES, [EDGE], 'orthogonal')
    const a = anchors.get('A-B')
    expect([a?.fromSide, a?.toSide]).toEqual(['bottom', 'top'])
    expect(a?.from?.x).toBe(a?.to?.x)
    expect(a?.from?.x).toBeGreaterThanOrEqual(160)
    expect(a?.from?.x).toBeLessThanOrEqual(190)
  })

  it('realizes the promised zero-bend route', () => {
    const anchors = assignEdgeAnchors(NODES, [EDGE], 'orthogonal')
    const routed = routeEdge(NODES, EDGE, 'orthogonal', anchors.get('A-B'))
    expect(routed.path.length).toBe(2)
    expect(routed.path[0]?.x).toBe(routed.path[1]?.x)
  })

  it('leaves multi-edge sides on their fan-out fractions', () => {
    // A second edge sharing A's bottom side: fan-out fractions must win
    // over pair alignment, or the two corridors collapse onto each other.
    const nodes: SpatialNode[] = [
      ...NODES,
      { id: 'C', type: 'text', x: -250, y: 300, width: 200, height: 100, text: '' },
    ]
    const edges: CanvasEdge[] = [EDGE, { id: 'A-C', fromNode: 'A', toNode: 'C' }]
    const anchors = assignEdgeAnchors(nodes, edges, 'orthogonal')
    const ab = anchors.get('A-B')
    const ac = anchors.get('A-C')
    expect(ab?.from?.x).not.toBe(ac?.from?.x)
  })
})
