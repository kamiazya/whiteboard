import type { CanvasEdge } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { type BendRouteEnds, bendRoute } from './bend-route.js'

const FROM = { x: 0, y: 0, w: 100, h: 50 }
const TO = { x: 400, y: 300, w: 100, h: 50 }

const edgeWith = (bends: unknown): CanvasEdge =>
  ({
    id: 'e',
    from: { node: 'a' },
    to: { node: 'b' },
    ...(bends === undefined ? {} : { bends }),
  }) as CanvasEdge

const route = (bends: unknown, ends: BendRouteEnds = {}) =>
  bendRoute(edgeWith(bends), FROM, TO, ends)

describe('the route through an edge’s stored bends', () => {
  it('draws through every bend, in order', () => {
    const path = route([
      { x: 200, y: 20 },
      { x: 200, y: 320 },
    ])
    expect(path?.slice(1, -1)).toEqual([
      { x: 200, y: 20 },
      { x: 200, y: 320 },
    ])
  })

  it('leaves and arrives at the anchor points the side pass chose', () => {
    const path = route([{ x: 200, y: 200 }], {
      fromSide: 'right',
      toSide: 'left',
      from: { x: 100, y: 12 },
      to: { x: 400, y: 333 },
    })
    expect(path?.[0]).toEqual({ x: 100, y: 12 })
    expect(path?.[path.length - 1]).toEqual({ x: 400, y: 333 })
  })

  it('falls back to the midpoint of the side when the fan-out moved no end', () => {
    const path = route([{ x: 200, y: 200 }], { fromSide: 'right', toSide: 'top' })
    // The right side's midpoint on a 100x50 box at the origin, and the top
    // side's on the far one.
    expect(path?.[0]).toEqual({ x: 100, y: 25 })
    expect(path?.[path.length - 1]).toEqual({ x: 450, y: 300 })
  })

  it('faces the neighbouring bend when no side was resolved at all', () => {
    const path = route([{ x: 50, y: -300 }])
    // The bend is straight above the from box, so the route must leave
    // through its top border rather than a compiled-in default side.
    expect(path?.[0]).toEqual({ x: 50, y: 0 })
  })

  it('declines an edge with no bends, so a route is computed instead', () => {
    expect(route(undefined)).toBeUndefined()
    expect(route([])).toBeUndefined()
  })

  it('declines a point this package cannot serialize rather than drawing half a path', () => {
    // `layoutSpatialCanvas` accepts an unparsed canvas, and `formatCoord`
    // throws on a non-finite number — which this package promises never to do.
    expect(route([{ x: Number.NaN, y: 0 }])).toBeUndefined()
    expect(route([{ x: 0, y: Number.POSITIVE_INFINITY }])).toBeUndefined()
  })
})
