// A plugin supplies the ALGORITHM, not just the geometry it draws with. It
// registers routers by bare name and answers `readRouting` for the edges it
// claims — the same shape `shapes` + `readShape` already have, so a plugin
// stores the choice in its OWN facet and cannot reach another's router.
//
// This file is the ONLY consumer of that seam, deliberately: no bundled plugin
// claims a router since ADR-0037 slice 4 moved bends into the model and the
// route into `bend-route.ts`. So these cases are not a unit test beside a real
// caller — they ARE what keeps a published extension point working, which is
// why they drive a fake plugin through `layoutSpatialCanvas` rather than
// calling `resolveRouterTable` directly. A test that stopped at the resolver would
// pass over wiring that no longer reaches the layout at all.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import type {
  EdgeRouteRequest,
  RenderContribution,
  ResolvedEdgeNode,
} from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { contributedRoute, resolveRouterTable } from './contributed-router.js'
import { layoutSpatialCanvas, type SpatialLayoutOptions } from './spatial-canvas.js'

const measure = createFakeMeasure()

const options: SpatialLayoutOptions = {
  measure,
  parseBody: (text) => ({
    type: 'root',
    children: [{ type: 'paragraph', children: [{ type: 'text', value: text }] }],
  }),
  appearance: {
    resolveNode: () => ({ appearance: { fill: '#fff', stroke: '#000' } }),
    resolveEdge: () => ({ stroke: '#000' }),
    resolveLabel: () => ({ fill: '#000', fontFamily: 'x' }),
  },
}

/**
 * The plugin's OWN facet, storing which of its routers an edge asked for —
 * exactly where a third-party plugin would keep it.
 *
 * The two ends differ in size AND position, so a router handed one end's box
 * in place of the other's, or an end in place of an obstacle, draws visibly
 * wrong rather than identically.
 */
const A = { x: 0, y: 0, w: 60, h: 40 }
const B = { x: 400, y: 300, w: 120, h: 80 }
const C = { x: 180, y: 140, w: 30, h: 20 }
const nodeAt = (id: string, box: typeof A) =>
  textNode({ id, x: box.x, y: box.y, width: box.w, height: box.h, text: id })

type Ends = { readonly fromEnd?: 'none' | 'arrow'; readonly toEnd?: 'none' | 'arrow' }

const routedElement = (routing: string | undefined, ends: Ends = {}) => ({
  id: 'e',
  from: { node: 'a', ...(ends.fromEnd === undefined ? {} : { end: ends.fromEnd }) },
  to: { node: 'b', ...(ends.toEnd === undefined ? {} : { end: ends.toEnd }) },
  ...(routing === undefined ? {} : { facets: { 'demo.route/v0': { name: routing } } }),
})

const board = (routing: string | undefined, ends: Ends = {}): SpatialCanvas => ({
  nodes: [nodeAt('a', A), nodeAt('b', B)],
  edges: [routedElement(routing, ends)],
})

/**
 * The same two ends with an obstacle between them, listed FIRST so a filter
 * that let an end through, or a lookup that took the first node it saw, would
 * show in what the router is handed.
 */
const boardWithObstacle = (routing: string): SpatialCanvas => ({
  nodes: [nodeAt('c', C), nodeAt('a', A), nodeAt('b', B)],
  edges: [routedElement(routing)],
})

/** The midpoint of one side of a box: where the anchor pass seats a lone edge. */
const midpointOf = (box: typeof A, side: 'right' | 'top') =>
  side === 'right' ? { x: box.x + box.w, y: box.y + box.h / 2 } : { x: box.x + box.w / 2, y: box.y }

/** What the plugin reads out of its own facet — the engine would do this. */
const storedRouting = (edge: { readonly facets?: Record<string, unknown> }) => {
  const stored = edge.facets?.['demo.route/v0'] as { name?: string } | undefined
  return stored?.name
}

/** A router with a signature no built-in produces: three points through a fixed detour. */
const DETOUR = { x: 999, y: -999 }
/** A two-point route, the shortest a router may answer — and a curved one. */
const STRAIGHT = [
  { x: -500, y: -500 },
  { x: 777, y: 777 },
]
const last: { request?: EdgeRouteRequest } = {}
const plugin: RenderContribution = {
  namespace: 'demo',
  readTheme: () => undefined,
  readRouting: (edge) => storedRouting(edge),
  routers: {
    detour: (request) => {
      last.request = request
      const start = request.anchors?.from ?? { x: request.from.x, y: request.from.y }
      const end = request.anchors?.to ?? { x: request.to.x, y: request.to.y }
      return { path: [start, DETOUR, end] }
    },
    straight: () => ({ path: STRAIGHT, rounded: true }),
    point: () => ({ path: [DETOUR] }),
    decline: () => null,
  },
}

const routedEdge = (canvas: SpatialCanvas): ResolvedEdgeNode | undefined =>
  layoutSpatialCanvas(canvas, { ...options, renderContributions: [plugin] }).nodes.find(
    (node): node is ResolvedEdgeNode => node.kind === 'edge',
  )

describe('a contributed edge router', () => {
  it('draws the path it returns when the edge asks for it by name', () => {
    // The ends default the JSON Canvas way, and no curve was asked for.
    expect(routedEdge(board('detour'))).toStrictEqual({
      kind: 'edge',
      id: 'e',
      path: [midpointOf(A, 'right'), DETOUR, midpointOf(B, 'top')],
      fromSide: 'right',
      toSide: 'top',
      fromEnd: 'none',
      toEnd: 'arrow',
      appearance: { stroke: '#000' },
    })
  })

  it('accepts a two-point route, keeps its curve and the arrowheads the edge stored', () => {
    expect(routedEdge(board('straight', { fromEnd: 'arrow', toEnd: 'none' }))).toStrictEqual({
      kind: 'edge',
      id: 'e',
      path: STRAIGHT,
      fromSide: 'right',
      toSide: 'top',
      fromEnd: 'arrow',
      toEnd: 'none',
      rounded: true,
      appearance: { stroke: '#000' },
    })
  })

  it('is told the endpoints, the obstacles and the sides the anchor pass chose', () => {
    last.request = undefined
    routedEdge(boardWithObstacle('detour'))
    // The sides are the anchor pass's choice for this geometry; the router is
    // handed them, with the point seated on each, rather than choosing.
    expect(last.request).toStrictEqual({
      edge: routedElement('detour'),
      from: A,
      to: B,
      // The two endpoints are never obstacles — an edge has to reach them.
      obstacles: [C],
      anchors: {
        fromSide: 'right',
        toSide: 'top',
        from: midpointOf(A, 'right'),
        to: midpointOf(B, 'top'),
      },
    })
  })

  it('falls back to the built-in when the router declines', () => {
    const path = routedEdge(board('decline'))?.path ?? []
    expect(path.some((point) => point.x === DETOUR.x)).toBe(false)
    expect(path.length).toBeGreaterThanOrEqual(2)
  })

  it('falls back to the built-in for a route too short to draw', () => {
    const path = routedEdge(board('point'))?.path ?? []
    expect(path.some((point) => point.x === DETOUR.x)).toBe(false)
    expect(path.length).toBeGreaterThanOrEqual(2)
  })

  it('falls back to the built-in for a name the contribution never registered', () => {
    const path = routedEdge(board('nosuchrouter'))?.path ?? []
    expect(path.some((point) => point.x === DETOUR.x)).toBe(false)
    expect(path.length).toBeGreaterThanOrEqual(2)
  })

  it('leaves an edge no contribution claims to the built-in', () => {
    const path = routedEdge(board(undefined))?.path ?? []
    expect(path.some((point) => point.x === DETOUR.x)).toBe(false)
    expect(path.length).toBeGreaterThanOrEqual(2)
  })
})

// The anchor pass always resolves both sides and both points for a node-to-node
// edge, so what a router is promised when it does NOT — the half-answers the
// contract exists to hide — is only reachable by calling the resolver itself.
describe('what a contributed router is promised about the anchors', () => {
  const resolution = { contributions: [plugin], routerTable: resolveRouterTable([plugin]) }
  const route = (anchors: Parameters<typeof contributedRoute>[3], canvas = board('detour')) => {
    last.request = undefined
    const edge = canvas.edges[0]
    if (edge === undefined) throw new Error('fixture has no edge')
    const routed = contributedRoute(canvas, edge, resolution, anchors)
    return { routed, request: last.request as EdgeRouteRequest | undefined }
  }

  it('hands no anchors, and draws from the default sides, when the pass resolved none', () => {
    const { routed, request } = route(undefined)
    expect(request?.anchors).toBeUndefined()
    expect(routed).toMatchObject({ fromSide: 'right', toSide: 'left' })
  })

  it('hands no anchors when only one side resolved', () => {
    expect(route({ fromSide: 'bottom' }).request?.anchors).toBeUndefined()
    expect(route({ toSide: 'top' }).request?.anchors).toBeUndefined()
  })

  it('hands both sides without points when no point was seated, and draws from them', () => {
    const { routed, request } = route({ fromSide: 'bottom', toSide: 'top' })
    expect(request?.anchors).toStrictEqual({ fromSide: 'bottom', toSide: 'top' })
    expect(routed).toMatchObject({ fromSide: 'bottom', toSide: 'top' })
  })

  it('never calls the router for an edge whose end node is missing', () => {
    for (const missing of ['from', 'to'] as const) {
      const canvas = board('detour')
      const gone = {
        ...canvas,
        nodes: canvas.nodes.filter((node) => node.id !== (missing === 'from' ? 'a' : 'b')),
      }
      const { routed, request } = route(undefined, gone)
      expect(routed).toBeUndefined()
      expect(request).toBeUndefined()
    }
  })
})
