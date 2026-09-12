// A named side asks where the line attaches. When the pair it names can
// only be honoured by a route through the box it attaches to — the lane's
// architecture board, every edge pinned bottom/top, same-row pairs included
// — the search treats the edge as free and re-sides it; a named pair that
// routes cleanly is kept exactly as named.
import type { CanvasEdge, SpatialNode } from '@kamiazya/whiteboard-model'
import { expect, it } from 'vitest'
import { interiorInk } from '../../quality/polyline-geometry.js'
import { assignEdgeAnchors, routeEdge } from './spatial-edges.js'

const node = (id: string, x: number, y: number): SpatialNode => ({
  id,
  type: 'text',
  x,
  y,
  width: 200,
  height: 80,
  text: id,
})
const ownInk = (path: readonly { x: number; y: number }[], n: SpatialNode) =>
  interiorInk(path, { x: n.x, y: n.y, w: n.width, h: n.height })

it('a named pair that forces a route through its own box is overruled', () => {
  const nodes = [node('api', 160, 380), node('auth', 400, 380)]
  const edges: CanvasEdge[] = [
    {
      id: 'e',
      from: { node: 'api', side: 'bottom' as const },
      to: { node: 'auth', side: 'top' as const },
    },
  ]
  const anchors = assignEdgeAnchors(nodes, edges, 'straight')
  const routed = routeEdge(nodes, edges[0] as CanvasEdge, 'straight', anchors.get('e'))
  expect({ from: routed.fromSide, to: routed.toSide }).toEqual({ from: 'right', to: 'left' })
  expect(
    ownInk(routed.path, nodes[0] as SpatialNode) + ownInk(routed.path, nodes[1] as SpatialNode),
  ).toBe(0)
})

it('a named pair that routes cleanly is kept as named', () => {
  const nodes = [node('web', 280, 80), node('api', 160, 380)]
  const edges: CanvasEdge[] = [
    {
      id: 'e',
      from: { node: 'web', side: 'bottom' as const },
      to: { node: 'api', side: 'top' as const },
    },
  ]
  const anchors = assignEdgeAnchors(nodes, edges, 'straight')
  const routed = routeEdge(nodes, edges[0] as CanvasEdge, 'straight', anchors.get('e'))
  expect({ from: routed.fromSide, to: routed.toSide }).toEqual({ from: 'bottom', to: 'top' })
})
