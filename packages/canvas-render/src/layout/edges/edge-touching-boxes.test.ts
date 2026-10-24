// Two boxes that touch — a shared border, or bodies that overlap — have no
// distance between them to route. The connection is marked where they meet:
// a run one arrowhead long ending on the target's facing side, centred on
// the stretch the two facing sides share. A positive gap keeps the ordinary
// route (`edge-near-boxes.test.ts`).

import type { CanvasEdge, EdgeRoutingStyle, EdgeSide } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { edgeArrowEnds } from '../../edge-arrows.js'
import { fc, fcTest, withDefaults } from '../../test-utils/fast-check.js'
import { node } from '../../test-utils/spatial-node.js'
import { routeEdge } from './edge-router.js'
import { assignEdgeAnchors } from './spatial-edges.js'

type Box = { x: number; y: number; w: number; h: number }

function route(a: Box, b: Box, style: EdgeRoutingStyle = 'orthogonal', edge?: CanvasEdge) {
  const nodes = [node('a', a.x, a.y, a.w, a.h), node('b', b.x, b.y, b.w, b.h)]
  const e: CanvasEdge = edge ?? { id: 'e', from: { node: 'a' }, to: { node: 'b' } }
  const anchors = assignEdgeAnchors(nodes, [e], style)
  return routeEdge(nodes, e, style, anchors.get(e.id))
}

describe('boxes sharing a border', () => {
  it('marks a side-by-side pair at the middle of the shared border', () => {
    const routed = route({ x: 0, y: 0, w: 120, h: 60 }, { x: 120, y: 0, w: 120, h: 60 })
    expect(routed.path).toEqual([
      { x: 110, y: 30 },
      { x: 120, y: 30 },
    ])
    expect({ from: routed.fromSide, to: routed.toSide }).toEqual({ from: 'right', to: 'left' })
    expect(edgeArrowEnds(routed).to).toBe(true)
  })

  it('leaves the pair out of the side search, so it takes no slot on a side', () => {
    const nodes = [node('a', 0, 0, 120, 60), node('b', 120, 0, 120, 60)]
    const edge: CanvasEdge = { id: 'e', from: { node: 'a' }, to: { node: 'b' } }
    expect(assignEdgeAnchors(nodes, [edge], 'orthogonal').get('e')).toBeUndefined()
  })

  it('centres the mark on the stretch the offset sides share', () => {
    const routed = route({ x: 0, y: 0, w: 120, h: 60 }, { x: 120, y: 20, w: 120, h: 60 })
    expect(routed.path).toEqual([
      { x: 110, y: 40 },
      { x: 120, y: 40 },
    ])
  })

  it('marks a stacked pair on the shared horizontal border', () => {
    const routed = route({ x: 0, y: 0, w: 120, h: 60 }, { x: 30, y: 60, w: 120, h: 60 })
    expect(routed.path).toEqual([
      { x: 75, y: 50 },
      { x: 75, y: 60 },
    ])
    expect({ from: routed.fromSide, to: routed.toSide }).toEqual({ from: 'bottom', to: 'top' })
  })

  it('points the mark at a target lying to the left', () => {
    const routed = route({ x: 120, y: 0, w: 120, h: 60 }, { x: 0, y: 0, w: 120, h: 60 })
    expect(routed.path).toEqual([
      { x: 130, y: 30 },
      { x: 120, y: 30 },
    ])
    expect({ from: routed.fromSide, to: routed.toSide }).toEqual({ from: 'left', to: 'right' })
  })

  for (const style of ['straight', 'curved'] as const) {
    it(`marks the contact in the ${style} style too`, () => {
      const routed = route({ x: 0, y: 0, w: 120, h: 60 }, { x: 120, y: 0, w: 120, h: 60 }, style)
      expect(routed.path).toEqual([
        { x: 110, y: 30 },
        { x: 120, y: 30 },
      ])
    })
  }

  it('keeps the route when the author named sides the contact does not use', () => {
    const edge: CanvasEdge = {
      id: 'e',
      from: { node: 'a', side: 'top' },
      to: { node: 'b', side: 'top' },
    }
    const routed = route(
      { x: 0, y: 0, w: 120, h: 60 },
      { x: 120, y: 0, w: 120, h: 60 },
      'orthogonal',
      edge,
    )
    expect(routed.path.length).toBeGreaterThan(2)
  })
})

describe('boxes that do not share a stretch of border', () => {
  it('routes a pair meeting only at a corner', () => {
    const routed = route({ x: 0, y: 0, w: 120, h: 60 }, { x: 120, y: 60, w: 120, h: 60 })
    expect(routed.path.length).toBeGreaterThan(2)
  })

  it('routes a pair whose author named one departure face the contact does not use', () => {
    const edge: CanvasEdge = { id: 'e', from: { node: 'a', side: 'bottom' }, to: { node: 'b' } }
    const routed = route(
      { x: 0, y: 0, w: 120, h: 60 },
      { x: 120, y: 0, w: 120, h: 60 },
      'orthogonal',
      edge,
    )
    expect(routed.fromSide).toBe('bottom')
    expect(routed.path.length).toBeGreaterThan(2)
  })
})

describe('a touching pair the author shaped', () => {
  it('routes a pair whose author named one arrival face the contact does not use', () => {
    const edge: CanvasEdge = { id: 'e', from: { node: 'a' }, to: { node: 'b', side: 'top' } }
    const routed = route(
      { x: 0, y: 0, w: 120, h: 60 },
      { x: 120, y: 0, w: 120, h: 60 },
      'orthogonal',
      edge,
    )
    expect(routed.toSide).toBe('top')
    expect(routed.path.length).toBeGreaterThan(2)
  })

  it('draws a pair through the bends it stores', () => {
    const edge: CanvasEdge = {
      id: 'e',
      from: { node: 'a' },
      to: { node: 'b' },
      bends: [{ x: 120, y: -40 }],
    }
    const routed = route(
      { x: 0, y: 0, w: 120, h: 60 },
      { x: 120, y: 0, w: 120, h: 60 },
      'orthogonal',
      edge,
    )
    expect(routed.path).toContainEqual({ x: 120, y: -40 })
    expect(routed.path[0]).toEqual({ x: 60, y: 0 })
  })
})

describe('boxes whose bodies overlap', () => {
  it('ends the mark on the target side inside the source', () => {
    const routed = route({ x: 0, y: 0, w: 120, h: 60 }, { x: 110, y: 0, w: 120, h: 60 })
    expect(routed.path).toEqual([
      { x: 100, y: 30 },
      { x: 110, y: 30 },
    ])
  })

  it('routes as before when one box holds the other', () => {
    const routed = route({ x: 0, y: 0, w: 300, h: 200 }, { x: 40, y: 40, w: 100, h: 60 })
    expect(routed.path).not.toHaveLength(2)
  })
})

const within = (p: { x: number; y: number }, r: Box) =>
  p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h

const onBorder = (p: { x: number; y: number }, r: Box) =>
  within(p, r) && (p.x === r.x || p.x === r.x + r.w || p.y === r.y || p.y === r.y + r.h)

const SIDES: readonly EdgeSide[] = ['left', 'right', 'top', 'bottom']

/**
 * A pair that touches or overlaps along one axis, with a positive shared
 * stretch across it, and neither box holding the other. The second box is
 * placed relative to the first so every generated pair is one the rule is
 * about — a uniform placement would almost never land two boxes in contact.
 */
const touchingPair = fc
  .record({
    a: fc.record({ w: fc.integer({ min: 20, max: 300 }), h: fc.integer({ min: 20, max: 300 }) }),
    b: fc.record({ w: fc.integer({ min: 20, max: 300 }), h: fc.integer({ min: 20, max: 300 }) }),
    side: fc.constantFrom(...SIDES),
    depthFraction: fc.double({ min: 0, max: 0.45, noNaN: true }),
    slideFraction: fc.double({ min: 0.02, max: 0.98, noNaN: true }),
    style: fc.constantFrom<EdgeRoutingStyle>('straight', 'orthogonal', 'curved'),
  })
  .map(({ a, b, side, depthFraction, slideFraction, style }) => {
    const horizontal = side === 'left' || side === 'right'
    const along = horizontal ? Math.min(a.w, b.w) : Math.min(a.h, b.h)
    const depth = Math.floor(along * depthFraction)
    // Slide across the contact axis so the shared stretch is at least 1px.
    const span = horizontal ? a.h + b.h - 2 : a.w + b.w - 2
    const slide = Math.round(span * slideFraction) - (horizontal ? b.h - 1 : b.w - 1)
    const boxA: Box = { x: 0, y: 0, w: a.w, h: a.h }
    const boxB: Box = {
      x: side === 'right' ? a.w - depth : side === 'left' ? -(b.w - depth) : slide,
      y: side === 'bottom' ? a.h - depth : side === 'top' ? -(b.h - depth) : slide,
      w: b.w,
      h: b.h,
    }
    return { a: boxA, b: boxB, style }
  })

describe('a touching pair never detours', () => {
  fcTest.prop({ pair: touchingPair }, withDefaults({ numRuns: 300 }))(
    'every point of the route lies on one of the two boxes, ending on the target',
    ({ pair }) => {
      const routed = route(pair.a, pair.b, pair.style)
      for (const point of routed.path) {
        expect(within(point, pair.a) || within(point, pair.b)).toBe(true)
      }
      expect(onBorder(routed.path.at(-1)!, pair.b)).toBe(true)
      expect(edgeArrowEnds(routed).to).toBe(true)
    },
  )
})
