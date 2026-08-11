// A routed edge must not tunnel through a bystander node's body when any
// candidate side pair routes clean: a line through a node reads as though
// it CONNECTS that node, which no line jump can express — worse than an
// extra edge crossing, which can. The optimizer therefore scores body
// intrusion in its heaviest slot, trading an edge crossing away to avoid
// a tunnel.
import type { CanvasEdge, SpatialNode } from '@kamiazya/whiteboard-canvas-model'
import { expect, it } from 'vitest'
import { assignEdgeAnchors, routeEdge } from './spatial-edges.js'

const box = (id: string, x: number, y: number, w: number, h: number): SpatialNode => ({
  id,
  type: 'text',
  x,
  y,
  width: w,
  height: h,
  text: id,
})

function intrusions(
  path: readonly { x: number; y: number }[],
  r: { x: number; y: number; w: number; h: number },
) {
  let n = 0
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] as { x: number; y: number }
    const b = path[i] as { x: number; y: number }
    const minX = Math.min(a.x, b.x)
    const maxX = Math.max(a.x, b.x)
    const minY = Math.min(a.y, b.y)
    const maxY = Math.max(a.y, b.y)
    if (minX < r.x + r.w - 1 && maxX > r.x + 1 && minY < r.y + r.h - 1 && maxY > r.y + 1) n++
  }
  return n
}

it('prefers an edge crossing over tunnelling through a bystander body', () => {
  // Reconstructed from a real canvas: blue sits above the tall box; the
  // bottom-arrival elbows and every detour are walled in by green and the
  // tall box, so that pair can only route THROUGH the tall body. The
  // left-arrival pair routes clean but costs one crossing with the gate
  // edge — which must be the accepted price.
  const nodes = [
    box('brown', 55, 862, 378, 188),
    box('green', -50, 1167, 526, 283),
    box('blue', 778, 862, 463, 288),
    box('tallRight', 778, 1662, 417, 868),
    box('bottomLeft', 155, 1788, 415, 625),
    box('gate1', 600, 600, 100, 60),
    box('gate2', 600, 2600, 100, 60),
  ]
  const edges: CanvasEdge[] = [
    { id: 'q', fromNode: 'bottomLeft', toNode: 'blue' },
    { id: 'h', fromNode: 'tallRight', toNode: 'bottomLeft' },
    { id: 'g', fromNode: 'bottomLeft', toNode: 'green' },
    { id: 'bg', fromNode: 'brown', toNode: 'green' },
    { id: 'gate', fromNode: 'gate1', toNode: 'gate2' },
  ]
  const anchors = assignEdgeAnchors(nodes, edges, 'orthogonal')
  const q = edges[0] as CanvasEdge
  const { path } = routeEdge(nodes, q, 'orthogonal', anchors.get('q'))
  expect(intrusions(path, { x: 778, y: 1662, w: 417, h: 868 })).toBe(0)
})
