// A routed segment must never run STRICTLY INSIDE a node's body: ink drawn
// across a node's interior reads as though the edge connects that node.
// border-tracing (edge-border-trace.test.ts) pins the complementary
// outline-riding invariant on this same canvas; this file pins interior
// ink, which border-tracing's collinear-ON-the-border check cannot see.
import type { CanvasEdge, SpatialNode } from '@kamiazya/whiteboard-model'
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

/** Independent oracle (never calls production code): total length of every
 * path segment that runs STRICTLY inside a rect's interior — a border-riding
 * or perpendicular-departure segment contributes 0, only a true interior
 * chord counts. */
function strictInteriorLength(
  path: readonly { x: number; y: number }[],
  rects: readonly { x: number; y: number; w: number; h: number }[],
): number {
  let total = 0
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] as { x: number; y: number }
    const b = path[i] as { x: number; y: number }
    for (const r of rects) {
      if (a.y === b.y && a.y > r.y && a.y < r.y + r.h) {
        const lo = Math.max(Math.min(a.x, b.x), r.x)
        const hi = Math.min(Math.max(a.x, b.x), r.x + r.w)
        if (hi > lo) total += hi - lo
      } else if (a.x === b.x && a.x > r.x && a.x < r.x + r.w) {
        const lo = Math.max(Math.min(a.y, b.y), r.y)
        const hi = Math.min(Math.max(a.y, b.y), r.y + r.h)
        if (hi > lo) total += hi - lo
      }
    }
  }
  return total
}

it('never routes a segment of A->B strictly inside any node body, on the exact user canvas', () => {
  const nodes = [
    box('A', 100, 570, 200, 100),
    box('B', 220, 520, 200, 100),
    box('T', 80, 360, 200, 110),
  ]
  const edges: CanvasEdge[] = [
    { id: 'ab', fromNode: 'A', toNode: 'B' },
    { id: 'ta', fromNode: 'T', toNode: 'A', label: 'hoge' },
    { id: 'tb', fromNode: 'T', toNode: 'B' },
  ]
  const anchors = assignEdgeAnchors(nodes, edges, 'orthogonal')
  const ab = edges[0] as CanvasEdge
  const { path } = routeEdge(nodes, ab, 'orthogonal', anchors.get('ab'))
  const rects = nodes.map((n) => ({ x: n.x, y: n.y, w: n.width, h: n.height }))
  expect(strictInteriorLength(path, rects)).toBe(0)
})
