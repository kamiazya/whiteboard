// Preventive properties over routeEdge and the rounded-edge decomposition —
// each pins an invariant whose violation shipped (or nearly shipped) as a
// real defect, generalized from its example test so the generator explores
// the arrangements nobody thought to write down.
import type { CanvasEdge, SpatialNode } from '@kamiazya/whiteboard-canvas-model'
import { describe, expect } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { flattenRoundedEdgePath } from './edge-rounding.js'
import { assignEdgeAnchors, routeEdge } from './spatial-edges.js'

const node = (
  id: string,
  type: 'text' | 'group',
  r: { x: number; y: number; w: number; h: number },
): SpatialNode =>
  type === 'group'
    ? { id, type, x: r.x, y: r.y, width: r.w, height: r.h }
    : { id, type, x: r.x, y: r.y, width: r.w, height: r.h, text: id }

const edge = (from: string, to: string): CanvasEdge => ({ id: 'e1', fromNode: from, toNode: to })

// A rect strictly inside a W x H frame at the origin, with margin >= 1.
const insideRect = (W: number, H: number) =>
  fc
    .record({
      x: fc.integer({ min: 1, max: W - 60 }),
      y: fc.integer({ min: 1, max: H - 40 }),
      w: fc.integer({ min: 20, max: 50 }),
      h: fc.integer({ min: 20, max: 30 }),
    })
    .filter((r) => r.x + r.w <= W - 1 && r.y + r.h <= H - 1)

const memberArrangement = fc
  .record({ W: fc.integer({ min: 200, max: 600 }), H: fc.integer({ min: 150, max: 400 }) })
  .chain(({ W, H }) =>
    fc.record({
      W: fc.constant(W),
      H: fc.constant(H),
      a: insideRect(W, H),
      b: insideRect(W, H),
    }),
  )

describe('routing properties: containers', () => {
  // The container is not an obstacle for its members' edges: the route
  // between two members of an empty group is EXACTLY the route with the
  // frame removed — the frame never adds a detour. (Stated as an
  // equivalence rather than "two points" because degenerate member
  // overlap can legitimately grow approach stubs, with or without the
  // frame.)
  fcTest.prop([memberArrangement], withDefaults())(
    "an empty group frame never changes its members' route",
    ({ W, H, a, b }) => {
      const withFrame = [
        node('g', 'group', { x: 0, y: 0, w: W, h: H }),
        node('a', 'text', a),
        node('b', 'text', b),
      ]
      const withoutFrame = [node('a', 'text', a), node('b', 'text', b)]
      expect(routeEdge(withFrame, edge('a', 'b'), 'straight').path).toEqual(
        routeEdge(withoutFrame, edge('a', 'b'), 'straight').path,
      )
    },
  )
})

describe('routing properties: orthogonal family', () => {
  const rect = fc.record({
    x: fc.integer({ min: -400, max: 400 }),
    y: fc.integer({ min: -400, max: 400 }),
    w: fc.integer({ min: 20, max: 200 }),
    h: fc.integer({ min: 20, max: 200 }),
  })
  const arrangement = fc.record({
    from: rect,
    to: rect,
    middles: fc.array(rect, { maxLength: 4 }),
  })

  const isAxisAligned = (path: readonly { x: number; y: number }[]) =>
    path.every((p, i) => {
      const prev = path[i - 1]
      return i === 0 || prev === undefined || p.x === prev.x || p.y === prev.y
    })

  fcTest.prop([arrangement], withDefaults())(
    'orthogonal routes are axis-aligned whatever stands in the way',
    ({ from, to, middles }) => {
      const nodes = [
        node('a', 'text', from),
        node('b', 'text', to),
        ...middles.map((m, i) => node(`m${i}`, 'text', m)),
      ]
      expect(isAxisAligned(routeEdge(nodes, edge('a', 'b'), 'orthogonal').path)).toBe(true)
    },
  )

  // 'curved' differs from 'orthogonal' only in asking for rounded corners:
  // same waypoints, same obstacles avoided. Divergence here is the drift
  // that made curved edges un-hit-testable.
  fcTest.prop([arrangement], withDefaults())(
    'curved travels exactly the orthogonal waypoints',
    ({ from, to, middles }) => {
      const nodes = [
        node('a', 'text', from),
        node('b', 'text', to),
        ...middles.map((m, i) => node(`m${i}`, 'text', m)),
      ]
      expect(routeEdge(nodes, edge('a', 'b'), 'curved').path).toEqual(
        routeEdge(nodes, edge('a', 'b'), 'orthogonal').path,
      )
    },
  )
})

describe('rounded-edge flattening properties', () => {
  const point = fc.record({
    x: fc.integer({ min: -1000, max: 1000 }),
    y: fc.integer({ min: -1000, max: 1000 }),
  })
  const waypoints = fc.array(point, { minLength: 2, maxLength: 8 })

  // The drawn curve never leaves the waypoint polyline's bounds (a
  // quadratic stays inside the triangle of its three points) — the
  // guarantee that lets sceneBounds/translate/scale keep working on the
  // waypoints alone.
  fcTest.prop([waypoints], withDefaults())(
    'flattening preserves endpoints and stays inside the waypoint bounds',
    (path) => {
      const flat = flattenRoundedEdgePath(path)
      expect(flat[0]).toEqual(path[0])
      expect(flat.at(-1)).toEqual(path.at(-1))

      const xs = path.map((p) => p.x)
      const ys = path.map((p) => p.y)
      const [minX, maxX] = [Math.min(...xs), Math.max(...xs)]
      const [minY, maxY] = [Math.min(...ys), Math.max(...ys)]
      for (const p of flat) {
        expect(p.x).toBeGreaterThanOrEqual(minX)
        expect(p.x).toBeLessThanOrEqual(maxX)
        expect(p.y).toBeGreaterThanOrEqual(minY)
        expect(p.y).toBeLessThanOrEqual(maxY)
      }
    },
  )
})

// Anchor fan-out invariants. The generator is a HUB topology — every edge
// touches node `hub`, so shared (node, side) groups are the common case
// rather than a lucky draw (a sparse generator would pass vacuously; the
// mutation check for this property is stacking every end back on the side
// midpoint, which must go red).
const hubScenario = fc.record({
  spokes: fc.uniqueArray(fc.constantFrom('s1', 's2', 's3', 's4', 's5'), {
    minLength: 2,
    maxLength: 5,
  }),
  spokePositions: fc.array(
    fc.record({
      x: fc.constantFrom(-200, 300, 300, 300, -200),
      y: fc.constantFrom(-150, 0, 150, 300, 450),
    }),
    { minLength: 5, maxLength: 5 },
  ),
  directions: fc.array(fc.boolean(), { minLength: 5, maxLength: 5 }),
  explicitSides: fc.array(fc.constantFrom(undefined, 'top' as const, 'right' as const), {
    minLength: 5,
    maxLength: 5,
  }),
})

describe('routing properties: anchor fan-out', () => {
  fcTest.prop([hubScenario], withDefaults())(
    'ends sharing a (node, side) never share a point, always sit on their side, and keep tangent order',
    ({ spokes, spokePositions, directions, explicitSides }) => {
      const hub: SpatialNode = {
        id: 'hub',
        type: 'text',
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        text: 'h',
      }
      const nodes: SpatialNode[] = [
        hub,
        ...spokes.map((id, i) => node(id, 'text', { ...spokePositions[i]!, w: 100, h: 100 })),
      ]
      const edges: CanvasEdge[] = spokes.map((id, i) => ({
        id: `e-${id}`,
        fromNode: directions[i]! ? 'hub' : id,
        toNode: directions[i]! ? id : 'hub',
        ...(explicitSides[i] === undefined
          ? {}
          : directions[i]!
            ? { fromSide: explicitSides[i] }
            : { toSide: explicitSides[i] }),
      }))
      const anchors = assignEdgeAnchors(nodes, edges)
      const routed = edges.map((e) => routeEdge(nodes, e, 'straight', anchors.get(e.id)))

      // Group the hub-side endpoint of every edge by reported side.
      const bySide = new Map<string, { point: { x: number; y: number }; far: SpatialNode }[]>()
      for (const [i, r] of routed.entries()) {
        const hubIsFrom = edges[i]!.fromNode === 'hub'
        const point = hubIsFrom ? r.path[0]! : r.path[r.path.length - 1]!
        const side = hubIsFrom ? r.fromSide : r.toSide
        const far = nodes.find((n) => n.id === spokes[i]!)!
        const entry = bySide.get(side)
        if (entry === undefined) bySide.set(side, [{ point, far }])
        else entry.push({ point, far })
      }
      for (const [side, ends] of bySide) {
        for (const { point } of ends) {
          // Every anchor lies ON the hub's reported side segment.
          if (side === 'left') expect(point.x).toBe(0)
          if (side === 'right') expect(point.x).toBe(100)
          if (side === 'top') expect(point.y).toBe(0)
          if (side === 'bottom') expect(point.y).toBe(100)
          expect(point.x).toBeGreaterThanOrEqual(0)
          expect(point.x).toBeLessThanOrEqual(100)
          expect(point.y).toBeGreaterThanOrEqual(0)
          expect(point.y).toBeLessThanOrEqual(100)
        }
        // No two ends on one side share a point.
        const keys = ends.map(({ point }) => `${point.x},${point.y}`)
        expect(new Set(keys).size).toBe(keys.length)
      }
    },
  )
})

// Occlusion-aware side selection. The generator packs chunky boxes onto a
// tight grid so overlap — and therefore an occluded default anchor — is
// the common case (vacuous-generator rule; the mutation check is reverting
// side selection to ignore occlusion, which must go red).
const packedScenario = fc.record({
  rects: fc.array(
    fc.record({
      x: fc.constantFrom(0, 40, 80, 120, 160),
      y: fc.constantFrom(0, 40, 80, 120),
      w: fc.constantFrom(60, 100, 140),
      h: fc.constantFrom(60, 100, 140),
    }),
    { minLength: 3, maxLength: 6 },
  ),
  fromIndex: fc.nat({ max: 5 }),
  toIndex: fc.nat({ max: 5 }),
})

describe('routing properties: occlusion-aware sides', () => {
  fcTest.prop([packedScenario], withDefaults())(
    'a derived side anchor is never strictly inside a foreign node unless every side is',
    ({ rects, fromIndex, toIndex }) => {
      const nodes = rects.map((r, i) => node(`n${i}`, 'text', r))
      const from = nodes[fromIndex % nodes.length]!
      const to = nodes[toIndex % nodes.length]!
      if (from.id === to.id) return
      const routed = routeEdge(nodes, { id: 'e', fromNode: from.id, toNode: to.id }, 'straight')

      const sidePoint = (n: SpatialNode, side: string) => {
        if (side === 'top') return { x: n.x + n.width / 2, y: n.y }
        if (side === 'bottom') return { x: n.x + n.width / 2, y: n.y + n.height }
        if (side === 'left') return { x: n.x, y: n.y + n.height / 2 }
        return { x: n.x + n.width, y: n.y + n.height / 2 }
      }
      const strictlyInside = (r: SpatialNode, p: { x: number; y: number }) =>
        p.x > r.x && p.x < r.x + r.width && p.y > r.y && p.y < r.y + r.height
      const check = (self: SpatialNode, side: string) => {
        const occluders = nodes.filter(
          (n) =>
            n.id !== from.id &&
            n.id !== to.id &&
            !(
              self.x >= n.x &&
              self.y >= n.y &&
              self.x + self.width <= n.x + n.width &&
              self.y + self.height <= n.y + n.height
            ),
        )
        const occluded = (s: string) => occluders.some((o) => strictlyInside(o, sidePoint(self, s)))
        const allOccluded = ['top', 'right', 'bottom', 'left'].every(occluded)
        expect(allOccluded || !occluded(side)).toBe(true)
      }
      check(from, routed.fromSide)
      check(to, routed.toSide)
    },
  )
})
