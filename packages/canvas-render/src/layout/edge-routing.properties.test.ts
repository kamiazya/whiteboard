// Preventive properties over routeEdge and the rounded-edge decomposition —
// each pins an invariant whose violation shipped (or nearly shipped) as a
// real defect, generalized from its example test so the generator explores
// the arrangements nobody thought to write down.
import type { CanvasEdge, SpatialNode } from '@kamiazya/whiteboard-canvas-model'
import { describe, expect } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { flattenRoundedEdgePath } from './edge-rounding.js'
import { routeEdge } from './spatial-edges.js'

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
  // The container is not an obstacle for its members' edges: with nothing
  // else on the canvas, the straight route between two members is the
  // direct segment — never a detour around the frame.
  fcTest.prop([memberArrangement], withDefaults())(
    'an edge between two members of an empty group is the direct segment',
    ({ W, H, a, b }) => {
      const nodes = [
        node('g', 'group', { x: 0, y: 0, w: W, h: H }),
        node('a', 'text', a),
        node('b', 'text', b),
      ]
      expect(routeEdge(nodes, edge('a', 'b'), 'straight').path).toHaveLength(2)
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
