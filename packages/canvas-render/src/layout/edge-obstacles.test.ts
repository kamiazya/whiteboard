import type { CanvasEdge, SpatialNode } from '@kamiazya/whiteboard-model'
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

  // A rect that contains an edge's endpoint can never be routed around —
  // every detour still has to reach the point inside it. A group enclosing
  // its members is the everyday case: edges between two nodes in the same
  // group used to detour all the way around the group's frame.
  it('ignores a group that encloses both endpoints', () => {
    const group: SpatialNode = { id: 'g', type: 'group', x: 0, y: 0, width: 800, height: 600 }
    const nodes = [group, node('a', 100, 100), node('b', 100, 400)]
    const routed = routeEdge(nodes, edge('a', 'b'))

    expect(routed.path).toEqual([
      { x: 150, y: 160 },
      { x: 150, y: 400 },
    ])
  })

  it('ignores a group that encloses one endpoint, so the edge pierces its border', () => {
    const group: SpatialNode = { id: 'g', type: 'group', x: 0, y: 0, width: 400, height: 400 }
    const nodes = [group, node('a', 100, 100), node('b', 600, 100)]
    const routed = routeEdge(nodes, edge('a', 'b'))

    expect(routed.path).toEqual([
      { x: 200, y: 130 },
      { x: 600, y: 130 },
    ])
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

describe('orthogonal routing style', () => {
  const isAxisAligned = (path: readonly { x: number; y: number }[]) =>
    path.every((point, i) => {
      if (i === 0) return true
      const prev = path[i - 1] as typeof point
      return point.x === prev.x || point.y === prev.y
    })

  it('bends into right angles even when the direct path is clear', () => {
    const nodes = [node('a', 0, 0), node('b', 400, 200)]
    const routed = routeEdge(nodes, edge('a', 'b'), 'orthogonal')

    expect(routed.path.length).toBeGreaterThan(2)
    expect(isAxisAligned(routed.path)).toBe(true)
  })

  it('leaves a straight-style edge diagonal, so the setting is what decides', () => {
    const nodes = [node('a', 0, 0), node('b', 400, 200)]
    const routed = routeEdge(nodes, edge('a', 'b'), 'straight')

    expect(routed.path).toHaveLength(2)
  })

  it('stays axis-aligned while stepping around an obstacle', () => {
    const blocker = node('mid', 200, 0)
    const nodes = [node('a', 0, 0), blocker, node('b', 400, 0)]
    const routed = routeEdge(nodes, edge('a', 'b'), 'orthogonal')

    expect(isAxisAligned(routed.path)).toBe(true)
    expect(pathCrosses(routed.path, blocker)).toBe(false)
  })

  it('defaults to straight when no style is given', () => {
    const nodes = [node('a', 0, 0), node('b', 400, 200)]
    expect(routeEdge(nodes, edge('a', 'b')).path).toHaveLength(2)
  })
})

// An edge that leaves a node sideways but starts by running vertically traces
// the node's own border for its first segment, so the two read as one line.
// Leaving and arriving along the side's outward normal is what separates them.
describe('orthogonal edges meet a node perpendicular to its side', () => {
  const axisOf = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    a.x === b.x ? 'vertical' : a.y === b.y ? 'horizontal' : 'diagonal'

  const firstAxis = (path: readonly { x: number; y: number }[]) =>
    axisOf(path[0] as { x: number; y: number }, path[1] as { x: number; y: number })
  const lastAxis = (path: readonly { x: number; y: number }[]) =>
    axisOf(path.at(-2) as { x: number; y: number }, path.at(-1) as { x: number; y: number })

  it('leaves a right-side attachment horizontally', () => {
    const nodes = [node('a', 0, 0), node('b', 400, 300)]
    const routed = routeEdge(nodes, { ...edge('a', 'b'), fromSide: 'right' }, 'orthogonal')

    expect(routed.fromSide).toBe('right')
    expect(firstAxis(routed.path)).toBe('horizontal')
  })

  it('leaves a bottom-side attachment vertically', () => {
    const nodes = [node('a', 0, 0), node('b', 400, 300)]
    const routed = routeEdge(nodes, { ...edge('a', 'b'), fromSide: 'bottom' }, 'orthogonal')

    expect(firstAxis(routed.path)).toBe('vertical')
  })

  it('arrives at a top-side attachment vertically', () => {
    const nodes = [node('a', 0, 0), node('b', 400, 300)]
    const routed = routeEdge(nodes, { ...edge('a', 'b'), toSide: 'top' }, 'orthogonal')

    expect(lastAxis(routed.path)).toBe('vertical')
  })

  it('arrives at a left-side attachment horizontally', () => {
    const nodes = [node('a', 0, 0), node('b', 400, 300)]
    const routed = routeEdge(nodes, { ...edge('a', 'b'), toSide: 'left' }, 'orthogonal')

    expect(lastAxis(routed.path)).toBe('horizontal')
  })

  it('holds for the derived sides too, with no explicit fromSide/toSide', () => {
    const nodes = [node('a', 0, 0), node('b', 400, 300)]
    const routed = routeEdge(nodes, edge('a', 'b'), 'orthogonal')
    const horizontalSide = routed.fromSide === 'left' || routed.fromSide === 'right'

    expect(firstAxis(routed.path)).toBe(horizontalSide ? 'horizontal' : 'vertical')
  })
})

// The orthogonal path never travels the direct diagonal, so asking whether
// THAT segment is blocked answers the wrong question: two obstacles can sit on
// the two elbows while leaving the diagonal clear, and the router would then
// build no detours and return a blocked elbow.
it('detours when both elbows are blocked but the direct line is not', () => {
  const onFirstElbow = node('m1', 200, 10, 40, 40)
  const onSecondElbow = node('m2', 100, 200, 40, 40)
  const nodes = [
    node('a', 0, 0, 100, 60),
    onFirstElbow,
    onSecondElbow,
    node('b', 400, 300, 100, 60),
  ]

  const routed = routeEdge(nodes, edge('a', 'b'), 'orthogonal')

  expect(pathCrosses(routed.path, onFirstElbow), 'crosses m1').toBe(false)
  expect(pathCrosses(routed.path, onSecondElbow), 'crosses m2').toBe(false)
})

// `curved` was accepted by the model but routed as `straight`, because the
// backend could only draw a polyline. It travels the orthogonal waypoints —
// perpendicular exit and entry, obstacles avoided — and asks for them to be
// drawn rounded rather than square.
describe('curved routing style', () => {
  it('asks for rounded corners', () => {
    const nodes = [node('a', 0, 0), node('b', 400, 300)]

    expect(routeEdge(nodes, edge('a', 'b'), 'curved').rounded).toBe(true)
    expect(routeEdge(nodes, edge('a', 'b'), 'orthogonal').rounded).toBeUndefined()
    expect(routeEdge(nodes, edge('a', 'b'), 'straight').rounded).toBeUndefined()
  })

  it('travels the same waypoints as orthogonal, so it avoids obstacles too', () => {
    const blocker = node('mid', 200, 0)
    const nodes = [node('a', 0, 0), blocker, node('b', 400, 0)]
    const curved = routeEdge(nodes, edge('a', 'b'), 'curved')

    expect(curved.path).toEqual(routeEdge(nodes, edge('a', 'b'), 'orthogonal').path)
    expect(pathCrosses(curved.path, blocker)).toBe(false)
  })
})
