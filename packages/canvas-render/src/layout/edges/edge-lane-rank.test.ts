// Lane depth by sweep rank: a corridor that travels PAST other anchors on
// its side must run deeper than their exit segments, or it crosses them
// right at the node — a crossing that exists only because of lane
// assignment, not because the two connections actually have to cross.
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

type P = { x: number; y: number }
function segmentsCross(a1: P, a2: P, b1: P, b2: P): boolean {
  const d = (p: P, q: P, r: P) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
  const [d1, d2, d3, d4] = [d(b1, b2, a1), d(b1, b2, a2), d(a1, a2, b1), d(a1, a2, b2)]
  return d1 * d2 < 0 && d3 * d4 < 0
}
function pathsCross(a: readonly P[], b: readonly P[]): boolean {
  for (let i = 1; i < a.length; i++)
    for (let j = 1; j < b.length; j++)
      if (segmentsCross(a[i - 1]!, a[i]!, b[j - 1]!, b[j]!)) return true
  return false
}

describe('lane depth by sweep rank', () => {
  it('an arrival sweeping past a departure takes the deeper lane — no crossing at the node', () => {
    // The reported shape: orange arrives at Red's UPPER right anchor from
    // Yellow (below); red departs the LOWER right anchor toward Cyan
    // (further below). Orange's corridor travels down past red's anchor,
    // so it must run OUTSIDE red's exit — index-ordered lanes put it
    // inside and forced a crossing.
    const nodes = [
      node('red', 0, 100, 300, 120),
      node('yellow', 450, 290, 260, 130),
      node('cyan', 630, 610, 280, 160),
    ]
    // Sides authored: this pins the LANE mechanics on one shared side (the
    // arrangement that used to cross); the bend-aware derivation would
    // otherwise legitimately route these ends via different sides.
    const edges: CanvasEdge[] = [
      { id: 'e-orange', fromNode: 'yellow', toNode: 'red', toSide: 'right' },
      { id: 'e-red', fromNode: 'red', toNode: 'cyan', fromSide: 'right' },
    ]
    const anchors = assignEdgeAnchors(nodes, edges)
    const orange = routeEdge(nodes, edges[0]!, 'orthogonal', anchors.get('e-orange'))
    const red = routeEdge(nodes, edges[1]!, 'orthogonal', anchors.get('e-red'))
    expect(pathsCross(orange.path, red.path)).toBe(false)
  })

  it('a lone end still keeps the exact base stub', () => {
    const pair = [node('a', 0, 0, 100, 100), node('b', 300, 300, 100, 100)]
    const e: CanvasEdge = { id: 'e1', fromNode: 'a', toNode: 'b' }
    const anchors = assignEdgeAnchors(pair, [e])
    const routed = routeEdge(pair, e, 'orthogonal', anchors.get('e1'))
    expect(routed.path[1]).toEqual({ x: 120, y: 50 })
  })
})
