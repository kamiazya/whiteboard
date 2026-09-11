import type { CanvasEdge } from '@kamiazya/whiteboard-model'
import type { EdgeRouteRequest } from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
import { VISUAL_PATH_KEY } from './data.js'
import { waypointRouter } from './edge-router.js'

const edgeWith = (waypoints: unknown): CanvasEdge => ({
  id: 'e',
  fromNode: 'a',
  toNode: 'b',
  ...(waypoints === undefined ? {} : { facets: { [VISUAL_PATH_KEY]: { waypoints } } }),
})

const request = (edge: CanvasEdge, anchors?: EdgeRouteRequest['anchors']): EdgeRouteRequest => ({
  edge,
  from: { x: 0, y: 0, w: 100, h: 50 },
  to: { x: 400, y: 300, w: 100, h: 50 },
  obstacles: [],
  anchors,
})

describe('the waypoint router', () => {
  it('draws through every stored bend, in order', () => {
    const route = waypointRouter(
      request(
        edgeWith([
          { x: 200, y: 20 },
          { x: 200, y: 320 },
        ]),
      ),
    )
    expect(route?.path.slice(1, -1)).toEqual([
      { x: 200, y: 20 },
      { x: 200, y: 320 },
    ])
  })

  it('leaves and arrives at the anchor points the side pass chose', () => {
    const route = waypointRouter(
      request(edgeWith([{ x: 200, y: 200 }]), {
        fromSide: 'right',
        toSide: 'left',
        from: { x: 100, y: 12 },
        to: { x: 400, y: 333 },
      }),
    )
    expect(route?.path[0]).toEqual({ x: 100, y: 12 })
    expect(route?.path[route.path.length - 1]).toEqual({ x: 400, y: 333 })
  })

  it('falls back to the midpoint of the side when the fan-out moved no end', () => {
    const route = waypointRouter(
      request(edgeWith([{ x: 200, y: 200 }]), { fromSide: 'right', toSide: 'top' }),
    )
    // The right side's midpoint on a 100x50 box at the origin, and the top
    // side's on the far one.
    expect(route?.path[0]).toEqual({ x: 100, y: 25 })
    expect(route?.path[route.path.length - 1]).toEqual({ x: 450, y: 300 })
  })

  it('faces the neighbouring bend when no side was resolved at all', () => {
    const route = waypointRouter(request(edgeWith([{ x: 50, y: -300 }])))
    // The bend is straight above the from box, so the route must leave
    // through its top border rather than a compiled-in default side.
    expect(route?.path[0]).toEqual({ x: 50, y: 0 })
  })

  it('declines an edge with no waypoints, so the built-in draws it', () => {
    expect(waypointRouter(request(edgeWith(undefined)))).toBeNull()
    expect(waypointRouter(request(edgeWith([])))).toBeNull()
  })

  it('declines a list past the ceiling, which a person never reaches and a generator does', () => {
    const many = Array.from({ length: 65 }, (_, at) => ({ x: at, y: at }))
    expect(waypointRouter(request(edgeWith(many)))).toBeNull()
    expect(waypointRouter(request(edgeWith(many.slice(0, 64))))?.path).toHaveLength(66)
  })

  it('declines a payload its own schema refuses rather than drawing half of it', () => {
    expect(waypointRouter(request(edgeWith([{ x: 10 }])))).toBeNull()
    expect(waypointRouter(request(edgeWith([{ x: Number.NaN, y: 0 }])))).toBeNull()
  })
})
