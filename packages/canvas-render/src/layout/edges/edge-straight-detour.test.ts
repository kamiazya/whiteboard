// A straight connection that has to avoid something stays as close to
// straight as it can: it bends at the corner of the box in its way, and
// steps around the boxes actually in its way rather than around one box
// covering all of them — which drew a short connection as a long
// right-angle detour around everything between its ends.
import type { CanvasEdge, SpatialNode } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { stackedFramesBoard } from '../../test-utils/routing-corpus.js'
import { crossings, interiorInk, pathLength } from '../../test-utils/routing-metrics.js'
import { node } from '../../test-utils/spatial-node.js'
import { routeEdge } from './edge-router.js'
import { assignEdgeAnchors } from './spatial-edges.js'

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

  it('arrives across the side it reaches, not along it', () => {
    // On two stacked frames of notes, a1 -> b6 passes the column between
    // them at a corner; the leg on from that corner ran 7 degrees off b6's
    // left side, sliding into the box edge-on.
    const { nodes, edges } = stackedFramesBoard()
    const anchors = assignEdgeAnchors(nodes, edges, 'straight')
    const edge = edges.find((e) => e.id === 'a1_b6')!
    const routed = routeEdge(nodes, edge, 'straight', anchors.get(edge.id))
    const end = routed.path[routed.path.length - 1]!
    const before = routed.path[routed.path.length - 2]!
    const normal = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] }[routed.toSide]
    const [nx, ny] = normal as [number, number]
    const outward = nx * (before.x - end.x) + ny * (before.y - end.y)
    const along = Math.abs(nx * (before.y - end.y) - ny * (before.x - end.x))
    expect(outward).toBeGreaterThan(along * 0.25)
  })
})

describe('a straight connection that would cross another to save length', () => {
  it('steps round instead, when that leaves the two uncrossed', () => {
    // a1 -> b6 and a3 -> b1 run corner to opposite corner between two
    // stacked frames. Bending at the corners of what blocks each makes the
    // two diagonals cross; stepping one round everything in its way does not.
    const { nodes, edges } = stackedFramesBoard()
    const anchors = assignEdgeAnchors(nodes, edges, 'straight')
    const paths = edges.map((edge) => routeEdge(nodes, edge, 'straight', anchors.get(edge.id)).path)
    expect(crossings(paths)).toBe(0)
  })

  it('keeps the corner route where stepping round buys nothing', () => {
    // The search starts every straight edge stepping round; with nothing
    // else on the board to cross, it must hand back the corner route.
    const nodes = [
      node('a', 0, 0, 120, 80),
      node('b', 300, 400, 120, 80),
      node('c', 130, 180, 160, 100),
    ]
    const edges = [{ id: 'e', from: { node: 'a' }, to: { node: 'b' } }]
    const anchors = assignEdgeAnchors(nodes, edges, 'straight')
    expect(anchors.get('e')?.around).toBeUndefined()
    const { path } = routeEdge(nodes, edges[0]!, 'straight', anchors.get('e'))
    expect(path).toHaveLength(3)
  })

  it('routes round the box covering everything in the way when asked', () => {
    // The corner route bends once at c's corner; `around` steps round c in
    // right angles, the way it did before corner routes existed.
    const nodes = [
      node('a', 0, 0, 120, 80),
      node('b', 300, 400, 120, 80),
      node('c', 130, 180, 160, 100),
    ]
    const edge = { id: 'e', from: { node: 'a' }, to: { node: 'b' } }
    const corner = routeEdge(nodes, edge, 'straight', { fromSide: 'bottom', toSide: 'top' })
    const around = routeEdge(nodes, edge, 'straight', {
      fromSide: 'bottom',
      toSide: 'top',
      around: true,
    })
    expect(around.path).not.toEqual(corner.path)
    expect(
      around.path.every(
        (p, i) => i === 0 || p.x === around.path[i - 1]!.x || p.y === around.path[i - 1]!.y,
      ),
    ).toBe(true)
  })
})
