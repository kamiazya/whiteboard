// The arrival stub is what makes a perpendicular pair read as two corners
// instead of one: the route reaches the elbow, continues 20px PAST the
// arrival anchor, then comes back to it. The departure stub stays — its
// depth is what separates edges that share a side into distinct
// corridors — so a one-corner route still carries a collinear stub point.
import type { CanvasEdge, SpatialNode } from '@kamiazya/whiteboard-canvas-model'
import { expect, it } from 'vitest'
import { assignEdgeAnchors, routeEdge } from './spatial-edges.js'

const node = (id: string, x: number, y: number, width: number, height: number): SpatialNode => ({
  id,
  type: 'text',
  x,
  y,
  width,
  height,
  text: '',
})

const edge = (id: string, fromNode: string, toNode: string, rest: Partial<CanvasEdge> = {}) =>
  ({ id, fromNode, toNode, ...rest }) as CanvasEdge

/** Direction changes between horizontal and vertical travel. */
function bendCount(path: readonly { x: number; y: number }[]): number {
  let bends = 0
  let axis: 'h' | 'v' | undefined
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] as { x: number; y: number }
    const b = path[i] as { x: number; y: number }
    if (a.x === b.x && a.y === b.y) continue
    const next = a.x === b.x ? 'v' : 'h'
    if (axis !== undefined && next !== axis) bends++
    axis = next
  }
  return bends
}

it('meets perpendicular sides at one corner instead of stubbing out of both', () => {
  const nodes = [node('A', 100, 570, 200, 100), node('B', 246, 510, 200, 100)]
  const edges = [edge('e', 'A', 'B')]
  const anchors = assignEdgeAnchors(
    nodes,
    edges,
    'orthogonal',
    new Map([['e', { fromSide: 'right' as const, toSide: 'bottom' as const }]]),
  )

  const { path } = routeEdge(nodes, edges[0] as CanvasEdge, 'orthogonal', anchors.get('e'))

  // A's right anchor already sits below B's bottom border, so the arrival
  // needs no excursion under it: right (through the departure stub, which
  // is collinear and so draws as one straight run), then up.
  expect(path).toEqual([
    { x: 300, y: 620 },
    { x: 320, y: 620 },
    { x: 346, y: 620 },
    { x: 346, y: 610 },
  ])
  expect(bendCount(path)).toBe(1)
})

it('keeps stubbing out when the corner would sit inside the arrival side', () => {
  // B is ABOVE A's right anchor here, so travelling right-then-up would
  // reach B's bottom from inside it. The stub-and-elbow path is correct.
  const nodes = [node('A', 100, 570, 200, 100), node('B', 400, 300, 200, 100)]
  const edges = [edge('e', 'A', 'B')]
  const anchors = assignEdgeAnchors(
    nodes,
    edges,
    'orthogonal',
    new Map([['e', { fromSide: 'right' as const, toSide: 'top' as const }]]),
  )

  const { path } = routeEdge(nodes, edges[0] as CanvasEdge, 'orthogonal', anchors.get('e'))

  expect(path.length).toBeGreaterThan(3)
})
