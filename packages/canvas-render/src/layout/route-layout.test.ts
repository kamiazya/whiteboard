import type { EdgeRoutingStyle, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import type { ResolvedEdgeNode, RoutableElement } from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
import { fakeLayoutCore } from '../test-utils/fake-layout-core.js'
import { routeEdge } from './edges/edge-router.js'
import { type RoutingCore, routeLayout } from './edges/layout-core.js'
import { createRoutingBudget } from './edges/routing-budget.js'
import { assignEdgeAnchors } from './edges/spatial-edges.js'

const canvas: SpatialCanvas = {
  nodes: [
    textNode({ id: 'a', x: 0, y: 0, width: 120, height: 60, text: 'a' }),
    textNode({ id: 'b', x: 400, y: 0, width: 120, height: 60, text: 'b' }),
    textNode({ id: 'c', x: 200, y: 300, width: 120, height: 60, text: 'c' }),
  ],
  edges: [
    { id: 'e1', from: { node: 'a' }, to: { node: 'b' } },
    { id: 'e2', from: { node: 'b' }, to: { node: 'c' } },
  ],
}

const styleOf = (): EdgeRoutingStyle => 'orthogonal'
const edges: readonly RoutableElement[] = canvas.edges

/** The composer's own routing over the canvas, on a fresh budget. */
function composerRoutes(): ReturnType<typeof routeLayout> {
  const budget = createRoutingBudget()
  const anchors = assignEdgeAnchors(canvas.nodes, edges, styleOf, undefined, budget, [])
  const routes = edges.map((edge) =>
    routeEdge(canvas.nodes, edge, styleOf(), anchors.get(edge.id), undefined, budget, []),
  )
  return { routes, anchors }
}

describe('routeLayout', () => {
  it('routes in the TypeScript composer when handed no core', () => {
    const routed = routeLayout(
      undefined,
      canvas.nodes,
      edges,
      styleOf,
      undefined,
      createRoutingBudget(),
      [],
    )
    expect(routed).toEqual(composerRoutes())
  })

  it("answers with the core when handed one, never the TypeScript, and keeps what it spends on the caller's budget", () => {
    const reference = composerRoutes()
    const [first, ...rest] = reference.routes as ResolvedEdgeNode[]
    const moved = { ...first, path: [{ x: 1, y: 2 }] } as ResolvedEdgeNode
    const asked: unknown[] = []
    const routing: RoutingCore = {
      routeLayout(nodes, routable, style, overrides, budget, labels) {
        asked.push({ nodes, routable, overrides, labels, style: style(routable[0]!) })
        budget.grid = 0
        return { routes: [moved, ...rest], anchors: reference.anchors }
      },
    }
    const budget = createRoutingBudget()
    const routed = routeLayout(
      fakeLayoutCore({ routing }),
      canvas.nodes,
      edges,
      styleOf,
      undefined,
      budget,
      [],
    )
    expect(routed.routes[0]).toBe(moved)
    expect(asked).toEqual([
      {
        nodes: canvas.nodes,
        routable: edges,
        overrides: undefined,
        labels: [],
        style: 'orthogonal',
      },
    ])
    expect(budget.grid).toBe(0)
  })

  it('throws what the core throws: there is no TypeScript to answer in its place', () => {
    const failure = new Error('refused')
    const core = fakeLayoutCore({
      routing: {
        routeLayout: () => {
          throw failure
        },
      },
    })
    expect(() =>
      routeLayout(core, canvas.nodes, edges, styleOf, undefined, createRoutingBudget(), []),
    ).toThrow(failure)
  })
})
