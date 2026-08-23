// The two stub-to-stub elbow candidates always tie on Manhattan length,
// so length alone cannot rank them. The routing invariant pinned here:
// among equal-length clear candidates, the one with fewer bends wins — in
// particular, an elbow collinear with BOTH stubs draws one corner, never a
// three-bend staircase.
import type { CanvasEdge, SpatialNode } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { assignEdgeAnchors, routeEdge } from './spatial-edges.js'

const box = (id: string, x: number, y: number, width: number, height: number): SpatialNode => ({
  id,
  type: 'text',
  x,
  y,
  width,
  height,
  text: id,
})

/** Direction changes along the polyline, ignoring repeated/collinear points. */
function bendCount(path: readonly { x: number; y: number }[]): number {
  const dirs: string[] = []
  for (let i = 1; i < path.length; i++) {
    const dx = Math.sign((path[i] as { x: number }).x - (path[i - 1] as { x: number }).x)
    const dy = Math.sign((path[i] as { y: number }).y - (path[i - 1] as { y: number }).y)
    if (dx === 0 && dy === 0) continue
    const dir = `${dx},${dy}`
    if (dirs[dirs.length - 1] !== dir) dirs.push(dir)
  }
  return Math.max(0, dirs.length - 1)
}

describe('orthogonal elbow tie-break', () => {
  it('prefers the elbow that stays collinear with both stubs: one bend, not three', () => {
    // Tall target on the left, source below-right of it. Exit stub points up
    // (top side), entry stub points right (right side): the vertical-first
    // elbow extends both stubs in a straight line and needs ONE corner; the
    // horizontal-first elbow jogs immediately and needs three. Both are the
    // same length and both are clear — only the bend count separates them.
    const nodes = [box('b', 0, 0, 200, 300), box('a', 150, 500, 200, 100)]
    const edges: CanvasEdge[] = [
      { id: 'e1', fromNode: 'a', toNode: 'b', fromSide: 'top', toSide: 'right' },
    ]
    const anchors = assignEdgeAnchors(nodes, edges)
    const { path } = routeEdge(nodes, edges[0] as CanvasEdge, 'orthogonal', anchors.get('e1'))

    expect(bendCount(path)).toBe(1)
    // The long vertical run rides the source stub's own x, not a jogged lane.
    expect(path.some((p) => p.x === 250 && p.y === 150)).toBe(true)
  })

  it('keeps the elbow ranking otherwise intact when only one candidate is clear', () => {
    // An obstacle sits on the vertical-first lane, so the staircase is the
    // only clear elbow — fewer bends must never beat clearance.
    const nodes = [
      box('b', 0, 0, 200, 300),
      box('a', 150, 500, 200, 100),
      box('wall', 230, 330, 60, 120),
    ]
    const edges: CanvasEdge[] = [
      { id: 'e1', fromNode: 'a', toNode: 'b', fromSide: 'top', toSide: 'right' },
    ]
    const anchors = assignEdgeAnchors(nodes, edges)
    const { path } = routeEdge(nodes, edges[0] as CanvasEdge, 'orthogonal', anchors.get('e1'))

    // Route exists and never crosses the wall body.
    expect(path.length).toBeGreaterThan(2)
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1] as { x: number; y: number }
      const b = path[i] as { x: number; y: number }
      const minX = Math.min(a.x, b.x)
      const maxX = Math.max(a.x, b.x)
      const minY = Math.min(a.y, b.y)
      const maxY = Math.max(a.y, b.y)
      const crosses = minX < 290 && maxX > 230 && minY < 450 && maxY > 330
      expect(crosses).toBe(false)
    }
  })
})
