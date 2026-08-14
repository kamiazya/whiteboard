// Two boxes that touch exactly can put both of an edge's anchors on the same
// point — flush-stacked nodes wired bottom-to-top land on the shared corner
// of their fan-out spans. `routeOrthogonal` assumes a direction to leave and
// arrive along; with none it built a stub each way and drew a spike 20px
// into one box and 40px back up through both.
//
// Found by the routing scoreboard's property, not by a report: it is exactly
// the arrangement `wb_canvas_tidy` produces when it snaps nodes into a
// column, so it is reachable without anyone placing boxes by hand.
import type { CanvasEdge, SpatialNode } from '@kamiazya/whiteboard-canvas-model'
import { describe, expect, it } from 'vitest'
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

  it('routes around the side that has room instead of vanishing', () => {
    // The boxes are flush on ONE axis; the other has space. An edge someone
    // drew must not disappear because the pair the ranking preferred happens
    // to be degenerate.
    const routed = routeWith({ id: 'e', fromNode: 'n0', toNode: 'n1' })
    expect({ from: routed.fromSide, to: routed.toSide }).toEqual({ from: 'left', to: 'left' })
    expect(routed.path.map((p) => `${p.x},${p.y}`)).toEqual(['17,20', '-3,20', '-3,60', '0,60'])
  })

  it('leaves no ink inside either box', () => {
    const { path } = routeWith({ id: 'e', fromNode: 'n0', toNode: 'n1' })
    for (const n of nodes) {
      expect({ node: n.id, ink: interiorInk(path, n) }).toEqual({ node: n.id, ink: 0 })
    }
  })

  it('draws the shared point, not a spike, when authored sides force the collision', () => {
    // Naming both sides is a request for that geometry. The re-siding above
    // deliberately leaves it alone, so the router still has to handle a pair
    // with no distance in it — and its answer is nothing, not 20px into one
    // box and 40px back through both.
    const { path } = routeWith({
      id: 'e',
      fromNode: 'n0',
      toNode: 'n1',
      fromSide: 'bottom',
      toSide: 'top',
    })
    expect(path.map((p) => `${p.x},${p.y}`)).toEqual(['38.5,40', '38.5,40'])
    for (const n of nodes) {
      expect({ node: n.id, ink: interiorInk(path, n) }).toEqual({ node: n.id, ink: 0 })
    }
  })
})
