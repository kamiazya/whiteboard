// A plugin supplies the ALGORITHM, not just the geometry it draws with. It
// registers routers by bare name and answers `readRouting` for the edges it
// claims — the same shape `shapes` + `readShape` already have, so a plugin
// stores the choice in its OWN facet and cannot reach another's router.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import type {
  EdgeRouteRequest,
  RenderContribution,
  ResolvedEdgeNode,
} from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
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
 */
const board = (routing: string | undefined): SpatialCanvas => ({
  nodes: [
    textNode({ id: 'a', x: 0, y: 0, width: 60, height: 40, text: 'a' }),
    textNode({ id: 'b', x: 400, y: 300, width: 60, height: 40, text: 'b' }),
  ],
  edges: [
    {
      id: 'e',
      from: { node: 'a' },
      to: { node: 'b' },
      ...(routing === undefined ? {} : { facets: { 'demo.route/v0': { name: routing } } }),
    },
  ],
})

/** What the plugin reads out of its own facet — the engine would do this. */
const storedRouting = (edge: { readonly facets?: Record<string, unknown> }) => {
  const stored = edge.facets?.['demo.route/v0'] as { name?: string } | undefined
  return stored?.name
}

/** A router with a signature no built-in produces: three points through a fixed detour. */
const DETOUR = { x: 999, y: -999 }
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
    decline: () => null,
  },
}

const routedEdge = (canvas: SpatialCanvas): ResolvedEdgeNode | undefined =>
  layoutSpatialCanvas(canvas, { ...options, renderContributions: [plugin] }).nodes.find(
    (node): node is ResolvedEdgeNode => node.kind === 'edge',
  )

describe('a contributed edge router', () => {
  it('draws the path it returns when the edge asks for it by name', () => {
    const path = routedEdge(board('detour'))?.path ?? []
    expect(path.some((point) => point.x === DETOUR.x && point.y === DETOUR.y)).toBe(true)
  })

  it('is told the endpoints, the obstacles and the sides the anchor pass chose', () => {
    last.request = undefined
    routedEdge({
      ...board('detour'),
      nodes: [
        ...board('detour').nodes,
        textNode({ id: 'c', x: 180, y: 140, width: 60, height: 40, text: 'c' }),
      ],
    })
    const request = last.request as EdgeRouteRequest | undefined
    expect(request).toBeDefined()
    expect(request?.edge.id).toBe('e')
    expect(request?.from.w).toBe(60)
    // The two endpoints are never obstacles — an edge has to reach them.
    expect(request?.obstacles).toHaveLength(1)
    expect(request?.anchors?.fromSide).toBeDefined()
  })

  it('falls back to the built-in when the router declines', () => {
    const path = routedEdge(board('decline'))?.path ?? []
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
