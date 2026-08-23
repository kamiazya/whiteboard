// Occlusion-aware default-side selection: when nodes overlap, the derived
// side's anchor can sit INSIDE another node — and a rect containing an
// endpoint is (correctly) never an obstacle, so the edge then legally
// cuts straight through that node. Picking an exposed side instead keeps
// the route outside; authored sides and fully-covered nodes keep the old
// behaviour.
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
    // b covers a's right-side midpoint; entering the shared region is the
    // point of the edge, not a crossing to avoid. b sits low enough that
    // dy is nonzero (an L-pair exists), so the exit stays 'right' by rank
    // and only broken occlusion logic — treating the edge's own target as
    // an occluder — would move it.
    const nodes = [node('a', 0, 0, 100, 100), node('b', 80, 10, 100, 100)]
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

describe('rectilinear alignment of the clean end', () => {
  it('slides the departure anchor along its side to meet the stub corridor squarely', () => {
    // Cyan's approach stub sits at (540, 90). Rather than a diagonal from
    // Red's right-center (190, 110), the departure slides up Red's right
    // side to y = 90: one horizontal run, one right-angle drop.
    const nodes = [
      node('red', 40, 60, 150, 100),
      node('green', 330, 140, 220, 140),
      node('cyan', 460, 110, 160, 110),
    ]
    const routed = routeEdge(nodes, edge('red', 'cyan'), 'straight')
    expect(routed.path).toEqual([
      { x: 190, y: 90 },
      { x: 540, y: 90 },
      { x: 540, y: 110 },
    ])
  })

  it('keeps the diagonal when the alignment target lies beyond the side span', () => {
    // Shrink Red so y = 90 falls outside its right side (with corner inset):
    // sliding cannot reach the corridor, so the stubbed diagonal stays.
    const nodes = [
      node('red', 40, 96, 150, 20),
      node('green', 330, 140, 220, 140),
      node('cyan', 460, 110, 160, 110),
    ]
    const routed = routeEdge(nodes, edge('red', 'cyan'), 'straight')
    const last = routed.path[routed.path.length - 1]!
    const beforeLast = routed.path[routed.path.length - 2]!
    expect(last).toEqual({ x: 540, y: 110 })
    expect(beforeLast).toEqual({ x: 540, y: 90 })
  })
})

describe('tight gaps narrower than the routing margin', () => {
  const crossesRect = (
    a: { x: number; y: number },
    b: { x: number; y: number },
    r: { x: number; y: number; w: number; h: number },
  ) => {
    let enter = 0
    let exit = 1
    for (const [delta, near, far] of [
      [b.x - a.x, r.x - a.x, r.x + r.w - a.x],
      [b.y - a.y, r.y - a.y, r.y + r.h - a.y],
    ] as const) {
      if (delta === 0) {
        if (near > 0 || far < 0) return false
        continue
      }
      const t0 = Math.min(near / delta, far / delta)
      const t1 = Math.max(near / delta, far / delta)
      enter = Math.max(enter, t0)
      exit = Math.min(exit, t1)
      if (enter >= exit) return false
    }
    return exit > enter
  }

  it('never tunnels through a node whose gap to the anchor is under the margin', () => {
    // F sits 5px right of a's anchor — inside a's margin band. F must stay
    // an obstacle for its RAW body: the route may cross the margin band to
    // escape the tight spot, but never F itself.
    const F = { x: 105, y: 0, w: 100, h: 100 }
    const nodes = [
      node('a', 0, 0, 100, 100),
      node('F', F.x, F.y, F.w, F.h),
      node('b', 400, 0, 100, 100),
    ]
    const routed = routeEdge(nodes, edge('a', 'b'), 'straight')
    for (let i = 1; i < routed.path.length; i++) {
      expect(crossesRect(routed.path[i - 1]!, routed.path[i]!, F)).toBe(false)
    }
  })
})
