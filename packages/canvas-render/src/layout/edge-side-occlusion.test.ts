// Occlusion-aware default-side selection: when nodes overlap, the derived
// side's anchor can sit INSIDE another node — and a rect containing an
// endpoint is (correctly) never an obstacle, so the edge then legally
// cuts straight through that node. Picking an exposed side instead keeps
// the route outside; authored sides and fully-covered nodes keep the old
// behaviour.
import type { CanvasEdge, SpatialNode } from '@kamiazya/whiteboard-canvas-model'
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

describe('occlusion-aware default sides', () => {
  it('moves the arrival to an exposed side when the default anchor sits inside an overlapping node', () => {
    // green overlaps cyan's left flank, so cyan's default left anchor
    // (420, 110) is inside green and the edge would cut through it. The
    // top anchor (490, 60) is exposed.
    const nodes = [
      node('red', 0, 0, 100, 100),
      node('green', 300, 80, 200, 120),
      node('cyan', 420, 60, 140, 100),
    ]
    const routed = routeEdge(nodes, edge('red', 'cyan'), 'straight')
    expect(routed.toSide).toBe('top')
    expect(routed.path[routed.path.length - 1]).toEqual({ x: 490, y: 60 })
    // The departure side is unobstructed and stays put.
    expect(routed.fromSide).toBe('right')
  })

  it('an authored side is honoured even when occluded', () => {
    const nodes = [
      node('red', 0, 0, 100, 100),
      node('green', 300, 80, 200, 120),
      node('cyan', 420, 60, 140, 100),
    ]
    const routed = routeEdge(nodes, edge('red', 'cyan', { toSide: 'left' }), 'straight')
    expect(routed.toSide).toBe('left')
  })

  it('a group frame fully containing the endpoint never counts as an occluder', () => {
    // m sits inside group g: every one of m's anchors is inside g, so if g
    // counted, every side would read occluded and the fallback would mask
    // the REAL occluder s covering m's right anchor. With g excluded, the
    // exposed bottom side wins.
    const nodes: SpatialNode[] = [
      { id: 'g', type: 'group', x: 0, y: 0, width: 600, height: 400 },
      node('m', 50, 150, 100, 100),
      node('s', 140, 140, 120, 120),
      node('f', 500, 150, 80, 100),
    ]
    const routed = routeEdge(nodes, edge('m', 'f'), 'straight')
    expect(routed.fromSide).toBe('bottom')
    expect(routed.path[0]).toEqual({ x: 100, y: 250 })
    // f is also inside g; g is excluded for it too, so its facing side stays.
    expect(routed.toSide).toBe('left')
  })

  it('falls back to the default side when every side is occluded', () => {
    const nodes = [
      node('a', 0, 0, 100, 100),
      node('o-right', 90, 40, 20, 20),
      node('o-left', -10, 40, 20, 20),
      node('o-top', 40, -10, 20, 20),
      node('o-bottom', 40, 90, 20, 20),
      node('b', 300, 0, 100, 100),
    ]
    const routed = routeEdge(nodes, edge('a', 'b'), 'straight')
    expect(routed.fromSide).toBe('right')
  })

  it('the far endpoint overlapping the anchor is not an occluder — the edge is going there', () => {
    // b overlaps a's right flank; entering the shared region is the point
    // of the edge, not a crossing to avoid.
    const nodes = [node('a', 0, 0, 100, 100), node('b', 80, 20, 100, 60)]
    const routed = routeEdge(nodes, edge('a', 'b'), 'straight')
    expect(routed.fromSide).toBe('right')
  })
})

describe('straight-style approach to a sideways anchor', () => {
  it('enters a top anchor from above instead of sliding along the border', () => {
    // Red's right-center and Cyan's top border share y = 110, so the direct
    // segment to the top anchor grazes ALONG Cyan's border. The route must
    // approach the top side perpendicular — from above.
    const nodes = [
      node('red', 40, 60, 150, 100),
      node('green', 330, 140, 220, 140),
      node('cyan', 460, 110, 160, 110),
    ]
    const routed = routeEdge(nodes, edge('red', 'cyan'), 'straight')
    expect(routed.toSide).toBe('top')
    const last = routed.path[routed.path.length - 1]!
    const beforeLast = routed.path[routed.path.length - 2]!
    expect(last).toEqual({ x: 540, y: 110 })
    expect(beforeLast.x).toBe(540)
    expect(beforeLast.y).toBeLessThan(110)
  })

  it('a plain facing pair keeps the two-point direct segment', () => {
    const nodes = [node('a', 0, 0, 100, 100), node('b', 300, 0, 100, 100)]
    const routed = routeEdge(nodes, edge('a', 'b'), 'straight')
    expect(routed.path).toEqual([
      { x: 100, y: 50 },
      { x: 300, y: 50 },
    ])
  })
})

describe('routing margin around foreign nodes', () => {
  it('a segment shaving past a foreign border detours with clearance instead', () => {
    // The direct a->b line passes 4px below o's bottom border — outside the
    // rect, so an unpadded crossing test lets it hug the border. Obstacles
    // are inflated by the routing margin, so the route detours clear.
    const nodes = [
      node('a', 0, 0, 100, 100),
      node('o', 150, -60, 100, 106),
      node('b', 400, 0, 100, 100),
    ]
    const routed = routeEdge(nodes, edge('a', 'b'), 'straight')
    expect(routed.path.length).toBeGreaterThan(2)
    for (const p of routed.path.slice(1, -1)) {
      const clearOfBand = p.y > 46 + 8 || p.y < -60 - 8
      expect(clearOfBand).toBe(true)
    }
  })
})
