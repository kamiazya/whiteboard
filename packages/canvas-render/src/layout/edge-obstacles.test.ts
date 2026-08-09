import type { CanvasEdge, SpatialNode } from '@kamiazya/whiteboard-canvas-model'
import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { routeEdge } from './spatial-edges.js'

/**
 * An edge drawn straight through whatever happens to lie between its
 * endpoints reads as though it connects the node it crosses. Routing now
 * steps around anything in the way — every node except the two the edge
 * belongs to, which it must touch.
 */

const node = (id: string, x: number, y: number, w = 100, h = 60): SpatialNode => ({
  id,
  type: 'text',
  x,
  y,
  width: w,
  height: h,
  text: id,
})

const edge = (from: string, to: string): CanvasEdge => ({
  id: 'e1',
  fromNode: from,
  toNode: to,
})

/** Whether a segment passes through a node's box (touching an edge does not count). */
function segmentCrosses(
  a: { x: number; y: number },
  b: { x: number; y: number },
  box: SpatialNode,
): boolean {
  const steps = 200
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const x = a.x + (b.x - a.x) * t
    const y = a.y + (b.y - a.y) * t
    if (x > box.x && x < box.x + box.width && y > box.y && y < box.y + box.height) return true
  }
  return false
}

const pathCrosses = (path: readonly { x: number; y: number }[], box: SpatialNode) =>
  path.some((point, i) => i > 0 && segmentCrosses(path[i - 1] as typeof point, point, box))

describe('obstacle-aware edge routing', () => {
  it('leaves a clear path exactly as it was: two points, endpoint to endpoint', () => {
    const nodes = [node('a', 0, 0), node('b', 400, 0)]
    const routed = routeEdge(nodes, edge('a', 'b'))

    expect(routed.path).toEqual([
      { x: 100, y: 30 },
      { x: 400, y: 30 },
    ])
  })

  it('steps around a node standing between the endpoints', () => {
    const blocker = node('mid', 200, 0)
    const nodes = [node('a', 0, 0), blocker, node('b', 400, 0)]
    const routed = routeEdge(nodes, edge('a', 'b'))

    expect(routed.path.length).toBeGreaterThan(2)
    expect(pathCrosses(routed.path, blocker)).toBe(false)
  })

  it('still touches both endpoints after detouring', () => {
    const nodes = [node('a', 0, 0), node('mid', 200, 0), node('b', 400, 0)]
    const routed = routeEdge(nodes, edge('a', 'b'))

    expect(routed.path[0]).toEqual({ x: 100, y: 30 })
    expect(routed.path.at(-1)).toEqual({ x: 400, y: 30 })
  })

  // The two endpoints are what the edge is FOR. Treating them as obstacles
  // would make every edge detour around its own ends.
  it('never treats its own endpoints as obstacles', () => {
    const from = node('a', 0, 0, 300, 300)
    const to = node('b', 400, 0, 300, 300)
    const routed = routeEdge([from, to], edge('a', 'b'))

    expect(routed.path).toHaveLength(2)
  })

  it('routes around several nodes in the way', () => {
    const blockers = [node('m1', 150, -20), node('m2', 260, 10)]
    const nodes = [node('a', 0, 0), ...blockers, node('b', 450, 0)]
    const routed = routeEdge(nodes, edge('a', 'b'))

    for (const blocker of blockers) {
      expect(pathCrosses(routed.path, blocker), `crosses ${blocker.id}`).toBe(false)
    }
  })

  // Layout must never abort over an arrangement no detour can clear.
  it('returns a finite path even when the obstacle cannot be cleared', () => {
    const swallowing = node('wall', -1000, -1000, 3000, 3000)
    const nodes = [node('a', 0, 0), swallowing, node('b', 400, 0)]
    const routed = routeEdge(nodes, edge('a', 'b'))

    expect(routed.path.length).toBeGreaterThanOrEqual(2)
    for (const point of routed.path) {
      expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true)
    }
  })
})

describe('routing properties', () => {
  const coord = fc.integer({ min: -400, max: 400 })
  const extent = fc.integer({ min: 1, max: 200 })
  const nodeArb = (id: string) =>
    fc.record({ x: coord, y: coord, w: extent, h: extent }).map((r) => node(id, r.x, r.y, r.w, r.h))

  fcTest.prop(
    [nodeArb('a'), nodeArb('b'), fc.array(nodeArb('m'), { maxLength: 4 })],
    withDefaults(),
  )('always yields a finite path anchored to both endpoints', (from, to, middles) => {
    const others = middles.map((m, i) => ({ ...m, id: `m${i}` }))
    const routed = routeEdge([from, to, ...others], edge('a', 'b'))

    expect(routed.path.length).toBeGreaterThanOrEqual(2)
    for (const point of routed.path) {
      expect(Number.isFinite(point.x)).toBe(true)
      expect(Number.isFinite(point.y)).toBe(true)
    }
  })
})
