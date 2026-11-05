// A straight connection that has to avoid something stays as close to
// straight as it can: it bends at the corner of the box in its way, and
// steps around the boxes actually in its way rather than around one box
// covering all of them — which drew a short connection as a long
// right-angle detour around everything between its ends.
import type { CanvasEdge, SpatialNode } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { interiorInk, pathLength } from '../../test-utils/routing-metrics.js'
import { node } from '../../test-utils/spatial-node.js'
import { routeEdge } from './edge-router.js'

const rectOf = (n: SpatialNode) => ({ x: n.x, y: n.y, w: n.width, h: n.height })

function route(nodes: readonly SpatialNode[], edge: CanvasEdge) {
  const { path } = routeEdge(nodes, edge, 'straight')
  const start = path[0]!
  const end = path[path.length - 1]!
  return {
    path,
    ratio: pathLength(path) / Math.hypot(end.x - start.x, end.y - start.y),
    inkThrough: (id: string) => interiorInk(path, rectOf(nodes.find((n) => n.id === id)!)),
  }
}

describe('a straight connection around a box in its way', () => {
  it('bends once, at the blocking box', () => {
    // The direct line runs from a's bottom to b's top, through c's middle.
    const nodes = [
      node('a', 0, 0, 120, 80),
      node('b', 300, 400, 120, 80),
      node('c', 130, 180, 160, 100),
    ]
    const routed = route(nodes, { id: 'e', from: { node: 'a' }, to: { node: 'b' } })
    expect(routed.inkThrough('c')).toBe(0)
    expect(routed.path).toHaveLength(3)
    expect(routed.ratio).toBeLessThan(1.15)
  })

  it('steps around each blocker rather than their union', () => {
    // Two tall boxes on the line, one reaching down and one reaching up: the
    // box covering both spans 650px across the line, and going round it is
    // the long way, where passing over one and under the other is not.
    const nodes = [
      node('a', 0, 200, 120, 80),
      node('b', 720, 200, 120, 80),
      node('c1', 220, 150, 100, 400),
      node('c2', 500, -100, 100, 400),
    ]
    const routed = route(nodes, { id: 'e', from: { node: 'a' }, to: { node: 'b' } })
    expect(routed.inkThrough('c1')).toBe(0)
    expect(routed.inkThrough('c2')).toBe(0)
    expect(routed.ratio).toBeLessThan(1.5)
  })
})
