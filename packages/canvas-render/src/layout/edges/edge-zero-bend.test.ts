// Zero-bend alignment: when an edge's two ends sit on OPPOSING, mutually
// facing sides whose spans overlap, one anchor slides along its side to the
// other's coordinate and the route is a single straight segment — anchors
// are renderer-chosen defaults, so trading their position for a bend-free
// line is the better-looking edge. Blocked lanes fall back to the elbows.
import type { CanvasEdge, SpatialNode } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { routeEdge } from './spatial-edges.js'

const node = (id: string, x: number, y: number, width: number, height: number): SpatialNode => ({
  id,
  type: 'text',
  x,
  y,
  width,
  height,
  text: id,
})

const edge = (fromNode: string, toNode: string, rest: Partial<CanvasEdge> = {}): CanvasEdge => ({
  id: 'e1',
  fromNode,
  toNode,
  ...rest,
})

describe('zero-bend alignment on opposing sides', () => {
  it('draws one vertical segment when the arrival can slide under the departure', () => {
    // a's bottom anchor is (400, 100); b's top span (110..490 with corner
    // inset) contains x = 400, so the arrival slides there and the route
    // is a single straight drop — no stub-jog-stub.
    const nodes = [node('a', 300, 0, 200, 100), node('b', 100, 300, 400, 100)]
    const routed = routeEdge(nodes, edge('a', 'b'), 'orthogonal')
    expect(routed.path).toEqual([
      { x: 400, y: 100 },
      { x: 400, y: 300 },
    ])
  })

  it('slides the departure instead when only its span can reach alignment', () => {
    // b's top anchor is (250, 300); a's bottom span (110..490) contains
    // x = 250 while b's span (210..290) cannot reach a's 400.
    const nodes = [node('a', 100, 0, 400, 100), node('b', 200, 300, 100, 100)]
    const routed = routeEdge(nodes, edge('a', 'b'), 'orthogonal')
    expect(routed.path).toEqual([
      { x: 250, y: 100 },
      { x: 250, y: 300 },
    ])
  })

  it('falls back to the elbows when the aligned lane is blocked', () => {
    const nodes = [
      node('a', 300, 0, 200, 100),
      node('block', 360, 150, 80, 100),
      node('b', 100, 300, 400, 100),
    ]
    const routed = routeEdge(nodes, edge('a', 'b'), 'orthogonal')
    expect(routed.path.length).toBeGreaterThan(2)
  })

  it('never aligns authored opposing sides that face AWAY from each other', () => {
    // b sits above a, but the authored sides say bottom -> top: a straight
    // "aligned" segment would run backwards through both nodes.
    const nodes = [node('a', 300, 300, 200, 100), node('b', 100, 0, 400, 100)]
    const routed = routeEdge(
      nodes,
      edge('a', 'b', { fromSide: 'bottom', toSide: 'top' }),
      'orthogonal',
    )
    expect(routed.path.length).toBeGreaterThan(2)
  })
})
