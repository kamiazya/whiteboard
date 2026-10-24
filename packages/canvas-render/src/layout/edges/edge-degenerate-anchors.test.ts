// Two boxes that touch exactly can put both of an edge's anchors on the same
// point — flush-stacked nodes wired bottom-to-top land on the shared border.
// There is no distance to route: `routeOrthogonal` assumed a direction to
// leave and arrive along and with none drew a spike, and re-siding the edge
// round the pair drew a loop that reads as anything but a connection. Such a
// pair is drawn as its contact instead (`edge-contact.ts`): one arrowhead's
// run ending on the shared border.
//
// It is exactly the arrangement the `tidy` op produces when it snaps nodes
// into a column, so it is reachable without anyone placing boxes by hand.

import type { CanvasEdge, SpatialNode } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { node } from '../../test-utils/spatial-node.js'
import { routeEdge } from './edge-router.js'
import { assignEdgeAnchors } from './spatial-edges.js'

/** Length of `path` running strictly inside a node's box. */
function interiorInk(path: readonly { x: number; y: number }[], n: SpatialNode): number {
  let total = 0
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] as { x: number; y: number }
    const b = path[i] as { x: number; y: number }
    if (a.x === b.x && a.x > n.x && a.x < n.x + n.width) {
      const lo = Math.max(Math.min(a.y, b.y), n.y)
      const hi = Math.min(Math.max(a.y, b.y), n.y + n.height)
      if (hi > lo) total += hi - lo
    }
    if (a.y === b.y && a.y > n.y && a.y < n.y + n.height) {
      const lo = Math.max(Math.min(a.x, b.x), n.x)
      const hi = Math.min(Math.max(a.x, b.x), n.x + n.width)
      if (hi > lo) total += hi - lo
    }
  }
  return total
}

describe('coincident anchors', () => {
  // n1 sits directly under n0, sharing the y = 40 boundary. Their fan-out
  // spans meet at one point, so bottom-to-top has no distance to travel.
  const nodes = [node('n0', 17, 0, 60, 40), node('n1', 0, 40, 60, 40)]

  const routeWith = (edge: CanvasEdge) => {
    const edges = [edge]
    const anchors = assignEdgeAnchors(nodes, edges, 'orthogonal')
    return routeEdge(nodes, edge, 'orthogonal', anchors.get(edge.id))
  }

  it('marks the middle of the shared border instead of vanishing', () => {
    // The shared stretch of the two facing sides is x 17..60.
    const routed = routeWith({ id: 'e', from: { node: 'n0' }, to: { node: 'n1' } })
    expect({ from: routed.fromSide, to: routed.toSide }).toEqual({ from: 'bottom', to: 'top' })
    expect(routed.path.map((p) => `${p.x},${p.y}`)).toEqual(['38.5,30', '38.5,40'])
  })

  it('keeps the mark out of the target and to one arrowhead inside the source', () => {
    const { path } = routeWith({ id: 'e', from: { node: 'n0' }, to: { node: 'n1' } })
    expect(nodes.map((n) => ({ node: n.id, ink: interiorInk(path, n) }))).toEqual([
      { node: 'n0', ink: 10 },
      { node: 'n1', ink: 0 },
    ])
  })

  it('draws the mark for a named pair that is the contact', () => {
    const { path, fromSide, toSide } = routeWith({
      id: 'e',
      from: { node: 'n0', side: 'bottom' as const },
      to: { node: 'n1', side: 'top' as const },
    })
    expect({ fromSide, toSide }).toEqual({ fromSide: 'bottom', toSide: 'top' })
    expect(path.map((p) => `${p.x},${p.y}`)).toEqual(['38.5,30', '38.5,40'])
  })
})
