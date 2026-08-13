// Two things make a perpendicular pair read badly. The arrival stub sends
// the route 20px PAST the anchor and back, which is a hook rather than a
// corner. And the corner's distance from the arrival side is whatever the
// departure anchor happened to be, which can leave the final segment
// shorter than the arrowhead drawn on it — a marker stuck to the box with
// no line behind it. The departure stub itself stays: its depth is what
// separates edges sharing a side into distinct corridors, so a one-corner
// route still carries a collinear stub point.
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

  // Right (through the collinear departure stub, so it draws as one
  // straight run), then up. The departure slid from y=620 to y=630 so the
  // final segment is 20px — the arrowhead's own length plus as much again
  // of plain line.
  expect(path).toEqual([
    { x: 300, y: 630 },
    { x: 320, y: 630 },
    { x: 346, y: 630 },
    { x: 346, y: 610 },
  ])
  expect(bendCount(path)).toBe(1)
  const approach = Math.abs((path[3] as { y: number }).y - (path[2] as { y: number }).y)
  expect(approach).toBeGreaterThanOrEqual(20)
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
