// Two boxes a few pixels apart, wired left to right, face each other: the
// short straight edge is the drawing, not a detour round both boxes.

import type { CanvasEdge } from '@kamiazya/whiteboard-model'
import { groupNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { node } from '../../test-utils/spatial-node.js'
import { routeEdge } from './edge-router.js'
import { assignEdgeAnchors } from './spatial-edges.js'

describe('a pipeline with other edges leaving the same box', () => {
  it('keeps the adjacent pair on one straight run', () => {
    const nodes = [
      node('auth', 170, 0, 125, 62),
      node('orders', 372, 0, 125, 62),
      node('pay', 505, 0, 125, 62),
      node('db', 703, 0, 125, 62),
      node('queue', 877, 0, 125, 62),
      groupNode({ id: 'g', x: 358, y: -15, width: 290, height: 92 }),
    ]
    const edges: CanvasEdge[] = [
      { id: 'a', from: { node: 'auth' }, to: { node: 'orders' } },
      { id: 'b', from: { node: 'orders' }, to: { node: 'pay' } },
      { id: 'c', from: { node: 'pay' }, to: { node: 'db' } },
      { id: 'd', from: { node: 'orders' }, to: { node: 'db' } },
      { id: 'e', from: { node: 'orders' }, to: { node: 'queue' } },
    ]
    const anchors = assignEdgeAnchors(nodes, edges, 'orthogonal')
    const edge = edges[1] as CanvasEdge
    const routed = routeEdge(nodes, edge, 'orthogonal', anchors.get(edge.id))
    expect(routed.path.length).toBe(2)
  })
})

describe('boxes a small gap apart', () => {
  for (const gap of [1, 4, 8, 12, 20]) {
    it(`routes a ${gap}px gap left to right as one short run`, () => {
      const nodes = [node('a', 0, 0, 120, 60), node('b', 120 + gap, 0, 120, 60)]
      const edge: CanvasEdge = { id: 'e', from: { node: 'a' }, to: { node: 'b' } }
      const anchors = assignEdgeAnchors(nodes, [edge], 'orthogonal')
      const routed = routeEdge(nodes, edge, 'orthogonal', anchors.get(edge.id))
      expect({ from: routed.fromSide, to: routed.toSide }).toEqual({ from: 'right', to: 'left' })
      const xs = routed.path.map((p) => p.x)
      expect(Math.min(...xs)).toBeGreaterThanOrEqual(120)
      expect(Math.max(...xs)).toBeLessThanOrEqual(120 + gap)
      expect(new Set(routed.path.map((p) => p.y)).size).toBe(1)
    })
  }
})
