// A routed path must never double back on itself: moving up then down, or
// left then right, on the SAME axis reads as a small knot/loop hanging off
// the node even though no other tier (overlap, border-tracing,
// endpoint-body-ink) prices it — the two retrograde segments are a few px
// apart, never collinear, so nothing catches it before path-reversal.
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

/** Independent oracle (never calls production code): direction reversals
 * per axis along a polyline — a segment whose sign on an axis is opposite
 * to the last non-zero sign on that same axis. */
function reversalCount(path: readonly { x: number; y: number }[]): number {
  let reversals = 0
  let lastSignX: number | undefined
  let lastSignY: number | undefined
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] as { x: number; y: number }
    const b = path[i] as { x: number; y: number }
    const sx = Math.sign(b.x - a.x)
    const sy = Math.sign(b.y - a.y)
    if (sx !== 0) {
      if (lastSignX !== undefined && sx === -lastSignX) reversals++
      lastSignX = sx
    }
    if (sy !== 0) {
      if (lastSignY !== undefined && sy === -lastSignY) reversals++
      lastSignY = sy
    }
  }
  return reversals
}

const userCanvasNodes = [
  box('A', 100, 570, 200, 100),
  box('B', 246, 510, 200, 100),
  box('T', 80, 360, 200, 110),
]
const userCanvasEdges: CanvasEdge[] = [
  { id: 'ab', fromNode: 'A', toNode: 'B' },
  { id: 'ta', fromNode: 'T', toNode: 'A', label: 'hoge' },
  { id: 'tb', fromNode: 'T', toNode: 'B' },
]

it('never settles A->B on a route that reverses on both axes, on the exact user canvas', () => {
  const anchors = assignEdgeAnchors(userCanvasNodes, userCanvasEdges, 'orthogonal')
  const ab = userCanvasEdges[0] as CanvasEdge
  const { path } = routeEdge(userCanvasNodes, ab, 'orthogonal', anchors.get('ab'))
  // A route may legitimately carry ONE reversal (a deliberate U-hook, see
  // the reachability pin below) — but never a double-axis knot.
  expect(reversalCount(path)).toBeLessThanOrEqual(1)
})

it('keeps T->A and T->B reversal-free on the same canvas (the fix must not buy the knot back on a neighbour)', () => {
  const anchors = assignEdgeAnchors(userCanvasNodes, userCanvasEdges, 'orthogonal')
  for (const id of ['ta', 'tb']) {
    const edge = userCanvasEdges.find((e) => e.id === id) as CanvasEdge
    const { path } = routeEdge(userCanvasNodes, edge, 'orthogonal', anchors.get(id))
    expect(reversalCount(path)).toBe(0)
  }
})

it('keeps a deliberate U-hook reachable for an interpenetrating pair with no valid alternative', () => {
  // Same-axis interpenetrating boxes: no zero-bend facing pair, no L-pair,
  // no gap-valid opposing pair — u-hook-when-degenerate's exact geometry.
  const nodes = [box('A2', 0, 0, 100, 100), box('B2', 50, 0, 100, 100)]
  const edges: CanvasEdge[] = [{ id: 'ab2', fromNode: 'A2', toNode: 'B2' }]
  const anchors = assignEdgeAnchors(nodes, edges, 'orthogonal')
  const ab2 = edges[0] as CanvasEdge
  const { path } = routeEdge(nodes, ab2, 'orthogonal', anchors.get('ab2'))
  // Settled pair stays the same-side hook it settled on before the rule
  // (top/top) — every candidate here reverses once, so they tie on the new
  // tier and incumbent-wins-ties + the existing preference order decide.
  expect(anchors.get('ab2')).toMatchObject({ fromSide: 'top', toSide: 'top' })
  expect(reversalCount(path)).toBe(1)
})
