// Preventive properties over routeEdge and the rounded-edge decomposition —
// each pins an invariant whose violation shipped (or nearly shipped) as a
// real defect, generalized from its example test so the generator explores
// the arrangements nobody thought to write down.
import type { CanvasEdge, SpatialNode } from '@kamiazya/whiteboard-model'
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

// Zero-bend alignment. Vertically stacked pairs whose x-spans always
// overlap (both contain 200..300): with nothing in the way, the orthogonal
// route must be a single straight segment — anchors slide rather than
// jogging. The mutation check is removing the alignment shortcut, which
// reintroduces the stub-jog-stub elbow.
const stackedPairArb = fc.record({
  aX: fc.integer({ min: 0, max: 200 }),
  aW: fc.integer({ min: 120, max: 400 }),
  bX: fc.integer({ min: 0, max: 200 }),
  bW: fc.integer({ min: 120, max: 400 }),
  // Vertical offset dominates every reachable horizontal offset (max ~340),
  // so side derivation always picks bottom/top — a 45-degree tie would pick
  // the horizontal pair and step outside this property's claim.
  gap: fc.integer({ min: 250, max: 500 }),
})

describe('routing properties: zero-bend alignment', () => {
  fcTest.prop([stackedPairArb], withDefaults())(
    'a facing vertical pair with overlapping spans routes as one straight segment',
    ({ aX, aW, bX, bW, gap }) => {
      // Both spans contain [200, 300], so an aligned lane always exists.
      const a = node('a', 'text', { x: aX, y: 0, w: Math.max(aW, 300 - aX + 20), h: 100 })
      const b = node('b', 'text', { x: bX, y: 100 + gap, w: Math.max(bW, 300 - bX + 20), h: 100 })
      const routed = routeEdge([a, b], edge('a', 'b'), 'orthogonal')
      expect(routed.path).toHaveLength(2)
      expect(routed.path[0]!.x).toBe(routed.path[1]!.x)
    },
  )
})

// Stub lane depth. All spokes sit far right of the hub, so every edge's
// from-end lands in the hub's (right) group; each member must exit through
// its own corridor (distinct stub x), lane 0 at exactly base depth, and no
// stub ever inside the hub itself. Mutation check: reverting the depth to
// the bare constant collapses every corridor onto one x.
const laneScenario = fc.record({
  count: fc.integer({ min: 1, max: 12 }),
  // Per-spoke jitter only: spokes are stacked at y = 150 + i*130 (+ jitter),
  // clear of the hub's own tangent span, so the zero-bend alignment can
  // never absorb the stub and every route actually exits through one.
  jitters: fc.array(fc.integer({ min: 0, max: 40 }), { minLength: 12, maxLength: 12 }),
})

describe('routing properties: stub lane depth', () => {
  fcTest.prop([laneScenario], withDefaults())(
    'every member of a shared side exits through a distinct corridor outside its node',
    ({ count, jitters }) => {
      const hub = node('hub', 'text', { x: 0, y: 0, w: 100, h: 100 })
      const spokes = Array.from({ length: count }, (_, i) =>
        node(`s${i}`, 'text', { x: 2000, y: 150 + i * 130 + jitters[i]!, w: 100, h: 100 }),
      )
      // fromSide authored: the property pins LANE mechanics on one shared
      // side; without it the bend-aware derivation legitimately splits the
      // group across sides.
      const edges: CanvasEdge[] = spokes.map((s, i) => ({
        id: `e${i}`,
        fromNode: 'hub',
        toNode: s.id,
        fromSide: 'right' as const,
      }))
      const anchors = assignEdgeAnchors([hub, ...spokes], edges)
      const exits = edges.map((e) => {
        const routed = routeEdge([hub, ...spokes], e, 'orthogonal', anchors.get(e.id))
        return routed.path[1]!.x
      })
      // The full lane ladder, not just uniqueness: base 120, step 12.
      expect([...exits].sort((a, b) => a - b)).toEqual(
        Array.from({ length: count }, (_, i) => 120 + i * 12),
      )
    },
  )
})

type PointXY = { x: number; y: number }

// Sweep-rank lanes. Spokes sit BOTH above and below the hub's right side,
// so the group mixes upward- and downward-sweeping corridors; no member's
// lane run may cross another member's exit segment right at the node.
// Mutation check: reverting depth to the list index reintroduces the
// crossing for a sweeping corridor given a shallow lane.
const mixedLaneScenario = fc.record({
  below: fc.integer({ min: 1, max: 5 }),
  above: fc.integer({ min: 1, max: 5 }),
  jitters: fc.array(fc.integer({ min: 0, max: 40 }), { minLength: 10, maxLength: 10 }),
})

describe('routing properties: sweep-rank lanes', () => {
  fcTest.prop([mixedLaneScenario], withDefaults())(
    'no lane run crosses another member exit at the node, for mixed sweep directions',
    ({ below, above, jitters }) => {
      const hub = node('hub', 'text', { x: 0, y: 0, w: 100, h: 100 })
      const spokes = [
        ...Array.from({ length: below }, (_, i) =>
          node(`d${i}`, 'text', { x: 2000, y: 250 + i * 130 + jitters[i]!, w: 100, h: 100 }),
        ),
        ...Array.from({ length: above }, (_, i) =>
          node(`u${i}`, 'text', { x: 2000, y: -250 - i * 130 - jitters[5 + i]!, w: 100, h: 100 }),
        ),
      ]
      const edges: CanvasEdge[] = spokes.map((s, i) => ({
        id: `e${i}`,
        fromNode: 'hub',
        toNode: s.id,
        fromSide: 'right' as const,
      }))
      const anchors = assignEdgeAnchors([hub, ...spokes], edges)
      const routed = edges.map((e) =>
        routeEdge([hub, ...spokes], e, 'orthogonal', anchors.get(e.id)),
      )
      const cross = (a1: PointXY, a2: PointXY, b1: PointXY, b2: PointXY) => {
        const d = (p: PointXY, q: PointXY, r: PointXY) =>
          (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
        return d(b1, b2, a1) * d(b1, b2, a2) < 0 && d(a1, a2, b1) * d(a1, a2, b2) < 0
      }
      for (const a of routed) {
        for (const b of routed) {
          if (a === b || a.path.length < 3 || b.path.length < 2) continue
          // a's lane run (stub to first turn) vs b's exit segment.
          expect(cross(a.path[1]!, a.path[2]!, b.path[0]!, b.path[1]!)).toBe(false)
        }
      }
    },
  )
})

// Crossing minimization. Dense chunky boxes with edges across them make
// crossings — and degenerate coincident stacks — the common case; the
// property pins that optimizing stays a pure deterministic function of
// the canvas, never throws, and never detaches an anchor from its
// reported side. The optimizer's ACCEPTANCE criterion (adopt only on a
// strict cost decrease) is pinned by the crossing-elimination example in
// edge-crossing-min.test.ts, whose mutation check inverts the comparison.
const clutterScenario = fc.record({
  rects: fc.array(
    fc.record({
      x: fc.constantFrom(0, 120, 240, 360, 480),
      y: fc.constantFrom(0, 120, 240, 360),
      w: fc.constantFrom(80, 140),
      h: fc.constantFrom(80, 140),
    }),
    { minLength: 4, maxLength: 6 },
  ),
  pairs: fc.array(fc.tuple(fc.nat({ max: 5 }), fc.nat({ max: 5 })), {
    minLength: 3,
    maxLength: 6,
  }),
})

function clutterConfig({
  rects,
  pairs,
}: {
  rects: { x: number; y: number; w: number; h: number }[]
  pairs: [number, number][]
}) {
  const nodes = rects.map((r, i) => node(`n${i}`, 'text', r))
  const edges: CanvasEdge[] = pairs
    .map(([f, t], i) => ({
      id: `e${i}`,
      fromNode: `n${f % nodes.length}`,
      toNode: `n${t % nodes.length}`,
    }))
    .filter((e) => e.fromNode !== e.toNode)
  return { nodes, edges }
}

describe('routing properties: crossing minimization', () => {
  fcTest.prop([clutterScenario], withDefaults({ numRuns: 60 }))(
    'optimizing stays deterministic, total, and keeps every anchor on its reported side',
    (scenario) => {
      const { nodes, edges } = clutterConfig(scenario)
      if (edges.length < 2) return
      const a = assignEdgeAnchors(nodes, edges, 'orthogonal')
      const b = assignEdgeAnchors(nodes, edges, 'orthogonal')
      expect(a).toEqual(b)
      const byId = new Map(nodes.map((n) => [n.id, n]))
      for (const e of edges) {
        const pair = a.get(e.id)
        const routed = routeEdge(nodes, e, 'orthogonal', pair)
        const onSide = (n: SpatialNode, side: string, p: PointXY) => {
          if (side === 'left') return p.x === n.x && p.y >= n.y && p.y <= n.y + n.height
          if (side === 'right') return p.x === n.x + n.width && p.y >= n.y && p.y <= n.y + n.height
          if (side === 'top') return p.y === n.y && p.x >= n.x && p.x <= n.x + n.width
          return p.y === n.y + n.height && p.x >= n.x && p.x <= n.x + n.width
        }
        expect(onSide(byId.get(e.fromNode)!, routed.fromSide, routed.path[0]!)).toBe(true)
        expect(
          onSide(byId.get(e.toNode)!, routed.toSide, routed.path[routed.path.length - 1]!),
        ).toBe(true)
      }
    },
  )
})
