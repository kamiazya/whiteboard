// An arrival is chosen as the partner of a particular departure. When
// occlusion moves the departure, keeping that arrival describes a pair the
// ranking never proposed, and the edge reaches its target the long way
// round: the reported canvas arrived at n2's BOTTOM from below, four
// corners, when n2's right side was one corner away.
import type { CanvasEdge, SpatialNode } from '@kamiazya/whiteboard-model'
import { expect, it } from 'vitest'
import { assignEdgeAnchors, routeEdge } from './spatial-edges.js'

const node = (id: string, x: number, y: number, w: number, h: number): SpatialNode => ({
  id,
  type: 'text',
  x,
  y,
  width: w,
  height: h,
  text: id,
})

it('re-pairs the arrival onto the axis the moved departure did not take', () => {
  // n1 buries n0's left anchor, so the departure moves left -> top. The
  // arrival must follow onto the horizontal axis (n2's right), not keep the
  // `bottom` that only existed as `left`'s partner.
  const nodes = [
    node('n0', 328, 383, 140, 137),
    node('n1', 273, 344, 104, 121),
    node('n2', 7, 216, 64, 133),
  ]
  const edges: CanvasEdge[] = [{ id: 'e', fromNode: 'n0', toNode: 'n2' }]
  const anchors = assignEdgeAnchors(nodes, edges, 'orthogonal')
  const routed = routeEdge(nodes, edges[0] as CanvasEdge, 'orthogonal', anchors.get('e'))
  expect({ from: routed.fromSide, to: routed.toSide }).toEqual({ from: 'top', to: 'right' })
  // One corner between the departure stub and the arrival.
  expect(routed.path.map((p) => `${p.x},${p.y}`)).toEqual([
    '398,383',
    '398,363',
    '398,282.5',
    '71,282.5',
  ])
})
