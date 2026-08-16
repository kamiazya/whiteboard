// Stub lane depth: edge ends sharing one (node, side) used to leave through
// the SAME stub corridor (side + 20px), running collinearly overlapped for
// their whole shared run — unreadable, and line jumps cannot express a
// parallel overlap. Each group member now gets a strictly deeper one-sided
// stub (base + i * step, in the group's existing sort order), so shared
// sides produce parallel DISTINCT corridors.
import type { CanvasEdge, SpatialNode } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { assignEdgeAnchors, routeEdge } from './spatial-edges.js'

const node = (id: string, x: number, y: number, width: number, height: number): SpatialNode => ({
  id,
  type: 'text',
  x,
  y,
  width,
  height,
  text: id,
})

/** Collinear vertical overlap between any segment pair of the two paths. */
function verticalOverlapLength(
  a: readonly { x: number; y: number }[],
  b: readonly { x: number; y: number }[],
): number {
  let total = 0
  for (let i = 1; i < a.length; i++) {
    for (let j = 1; j < b.length; j++) {
      const [p1, p2, q1, q2] = [a[i - 1]!, a[i]!, b[j - 1]!, b[j]!]
      if (p1.x !== p2.x || q1.x !== q2.x || p1.x !== q1.x) continue
      const lo = Math.max(Math.min(p1.y, p2.y), Math.min(q1.y, q2.y))
      const hi = Math.min(Math.max(p1.y, p2.y), Math.max(q1.y, q2.y))
      total += Math.max(0, hi - lo)
    }
  }
  return total
}

// The reported arrangement: an arrival and a departure share red's right
// side; both used to pick the corridor x = 320 and overlap for ~200px.
const nodes = [
  node('red', 0, 700, 300, 120),
  node('yellow', 450, 890, 260, 130),
  node('cyan', 630, 1270, 280, 200),
]
const edges: CanvasEdge[] = [
  { id: 'e-orange', fromNode: 'yellow', toNode: 'red' },
  { id: 'e-red', fromNode: 'red', toNode: 'cyan' },
]

describe('stub lane depth for shared sides', () => {
  it('two ends on one side leave through distinct corridors, never overlapping', () => {
    const anchors = assignEdgeAnchors(nodes, edges)
    const orange = routeEdge(nodes, edges[0]!, 'orthogonal', anchors.get('e-orange'))
    const red = routeEdge(nodes, edges[1]!, 'orthogonal', anchors.get('e-red'))
    expect(verticalOverlapLength(orange.path, red.path)).toBe(0)
  })

  it('a lone end keeps the exact 20px stub — unshared canvases are unchanged', () => {
    const pair = [node('a', 0, 0, 100, 100), node('b', 300, 300, 100, 100)]
    const e: CanvasEdge = { id: 'e1', fromNode: 'a', toNode: 'b' }
    const anchors = assignEdgeAnchors(pair, [e])
    const routed = routeEdge(pair, e, 'orthogonal', anchors.get('e1'))
    // fromSide right (dx tie rule): stub at x = 100 + 20.
    expect(routed.path[1]).toEqual({ x: 120, y: 50 })
  })

  it('curved shares the deepened waypoints', () => {
    const anchors = assignEdgeAnchors(nodes, edges)
    const orangeO = routeEdge(nodes, edges[0]!, 'orthogonal', anchors.get('e-orange'))
    const orangeC = routeEdge(nodes, edges[0]!, 'curved', anchors.get('e-orange'))
    expect(orangeC.path).toEqual(orangeO.path)
    expect(orangeC.rounded).toBe(true)
  })
})
