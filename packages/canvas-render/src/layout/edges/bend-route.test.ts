import type { CanvasEdge } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { type BendRouteEnds, bendRoute } from './bend-route.js'
import { routeEdge } from './spatial-edges.js'

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

describe('how a bent path is DRAWN', () => {
  const nodes = [
    textNode({ id: 'a', x: 0, y: 0, width: 100, height: 50, text: 'a' }),
    textNode({ id: 'b', x: 400, y: 300, width: 100, height: 50, text: 'b' }),
  ]
  const bent: CanvasEdge = {
    id: 'e',
    from: { node: 'a' },
    to: { node: 'b' },
    bends: [
      { x: 200, y: 20 },
      { x: 200, y: 320 },
    ],
  } as CanvasEdge

  it('rounds the corners of a CURVED element, the same as a computed route', () => {
    // The stored path answers WHERE the element goes; the style still says
    // how it is drawn, and the two are independent. Without this a freehand
    // stroke — a line that is all bends — came back as a chain of straight
    // segments with a visible corner at every sample the simplification
    // kept, which reads as a jagged stroke rather than a drawn one.
    expect(routeEdge(nodes, bent, 'curved', undefined).rounded).toBe(true)
  })

  it('leaves a straight element crisp', () => {
    // Waypoints somebody placed by hand on an ordinary edge are corners they
    // meant; only asking for `curved` softens them.
    expect(routeEdge(nodes, bent, 'straight', undefined).rounded).toBeUndefined()
  })
})
