// Ink through a node's BODY is worse than ink along its border: the body is
// content the line now crosses, the border is a stroke it merely doubles.
// The two rules were both demoted below crossings for the same trial-path
// reason, and their order relative to each other was never argued — with
// border-tracing above, the lexicographic compare bought 0px of border
// tracing with 170px of tunnelling straight through the target.
import type { CanvasEdge, SpatialNode } from '@kamiazya/whiteboard-canvas-model'
import { expect, it } from 'vitest'
import { PENALTY_RULES } from './edge-rules.js'
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

/** Length of path running strictly inside a node body — the harm being ranked. */
function interiorInk(
  path: readonly { x: number; y: number }[],
  rects: readonly SpatialNode[],
): number {
  let total = 0
  for (const n of rects) {
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1] as { x: number; y: number }
      const b = path[i] as { x: number; y: number }
      if (a.y === b.y && a.y > n.y && a.y < n.y + n.height) {
        const lo = Math.max(Math.min(a.x, b.x), n.x)
        const hi = Math.min(Math.max(a.x, b.x), n.x + n.width)
        if (hi > lo) total += hi - lo
      }
      if (a.x === b.x && a.x > n.x && a.x < n.x + n.width) {
        const lo = Math.max(Math.min(a.y, b.y), n.y)
        const hi = Math.min(Math.max(a.y, b.y), n.y + n.height)
        if (hi > lo) total += hi - lo
      }
    }
  }
  return total
}

it('ranks interior ink above border tracing', () => {
  const tier = (name: string) => PENALTY_RULES.find((r) => r.name === name)?.tier
  expect(tier('endpoint-body-ink')).toBeLessThan(tier('border-tracing') as number)
})

it('never routes through a node body when a border-tracing route would avoid it', () => {
  const nodes = [
    node('A', 100, 570, 200, 100),
    node('B', 280, 520, 200, 100),
    node('T', 80, 360, 200, 110),
  ]
  const edges: CanvasEdge[] = [
    { id: 'e_AB', fromNode: 'A', toNode: 'B' },
    { id: 'e_TA', fromNode: 'T', toNode: 'A', label: 'hoge' },
    { id: 'e_TB', fromNode: 'T', toNode: 'B' },
  ]
  const anchors = assignEdgeAnchors(nodes, edges, 'orthogonal')

  for (const edge of edges) {
    const { path } = routeEdge(nodes, edge, 'orthogonal', anchors.get(edge.id))
    expect({ id: edge.id, interior: interiorInk(path, nodes) }).toEqual({
      id: edge.id,
      interior: 0,
    })
  }
})
