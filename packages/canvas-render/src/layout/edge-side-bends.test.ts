// Bend-aware default sides: for a diagonal pair with no zero-bend lane, an
// L-route through perpendicular sides reaches the target with ONE bend,
// while the dominant-axis opposing pair needs a Z with two — and may share
// a side other edges already occupy. The derivation now ranks side pairs
// by estimated bends, breaking L-ties toward the less crowded side.
import type { CanvasEdge, SpatialNode } from '@kamiazya/whiteboard-canvas-model'
import { describe, expect, it } from 'vitest'
import { assignEdgeAnchors, routeEdge } from './spatial-edges.js'

const node = (id: string, x: number, y: number, width: number, height: number): SpatialNode => ({
  id,
  type: 'text',
  x,
  y,
  width,
  height,
  text: id,
})

function bends(path: readonly { x: number; y: number }[]): number {
  let count = 0
  for (let i = 2; i < path.length; i++) {
    const [a, b, c] = [path[i - 2]!, path[i - 1]!, path[i]!]
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
    if (cross !== 0) count++
  }
  return count
}

describe('bend-aware default sides', () => {
  it('a diagonal departure leaves the uncrowded perpendicular side as a one-bend L', () => {
    // The reported shape: Red -> Cyan is diagonal (no zero-bend lane on
    // either axis); Red's right side is already occupied by the orange
    // arrival. Leaving Red's BOTTOM reaches Cyan's left in one bend.
    const nodes = [
      node('red', 0, 100, 300, 120),
      node('yellow', 450, 290, 260, 130),
      node('cyan', 630, 610, 280, 160),
    ]
    const edges: CanvasEdge[] = [
      { id: 'e-orange', fromNode: 'yellow', toNode: 'red' },
      { id: 'e-red', fromNode: 'red', toNode: 'cyan' },
    ]
    const anchors = assignEdgeAnchors(nodes, edges)
    const red = routeEdge(nodes, edges[1]!, 'orthogonal', anchors.get('e-red'))
    expect(red.fromSide).toBe('bottom')
    expect(red.toSide).toBe('left')
    expect(bends(red.path)).toBe(1)
  })

  it('an aligned facing pair still takes the zero-bend opposing lane, never an L', () => {
    const nodes = [node('a', 0, 0, 100, 100), node('b', 400, 20, 100, 100)]
    const e: CanvasEdge = { id: 'e1', fromNode: 'a', toNode: 'b' }
    const anchors = assignEdgeAnchors(nodes, [e])
    const routed = routeEdge(nodes, e, 'orthogonal', anchors.get('e1'))
    expect(routed.fromSide).toBe('right')
    expect(routed.toSide).toBe('left')
    expect(bends(routed.path)).toBe(0)
  })

  it('authored sides always win over the bend estimate', () => {
    const nodes = [node('a', 0, 100, 300, 120), node('b', 630, 610, 280, 160)]
    const e: CanvasEdge = { id: 'e1', fromNode: 'a', toNode: 'b', fromSide: 'right' }
    const anchors = assignEdgeAnchors(nodes, [e])
    const routed = routeEdge(nodes, e, 'orthogonal', anchors.get('e1'))
    expect(routed.fromSide).toBe('right')
  })
})
