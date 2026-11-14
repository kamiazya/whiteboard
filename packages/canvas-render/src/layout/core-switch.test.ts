import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import type { ResolvedEdgeNode, SceneNode } from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
import { routeEdge } from './edges/edge-router.js'
import type { CoreImpl, CoreMismatch, LayoutCore, RoutingCore } from './edges/layout-core.js'
import { assignEdgeAnchors } from './edges/spatial-edges.js'
import type { SpatialLayoutOptions } from './spatial-canvas.js'
import { layoutSpatialCanvasWithAnchors } from './spatial-canvas.js'

const measure = () => ({ advanceWidth: 12, ascent: 10, descent: 2, lineGap: 0 })
const parseBody = () => ({ type: 'root' as const, children: [] })
const appearance = {
  resolveNode: () => ({ radius: 8 }),
  resolveEdge: () => ({ stroke: '#606060', strokeWidth: 1.5 }),
  resolveLabel: () => ({ fill: '#303030', fontFamily: 'sans-serif' }),
}

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
  facets: { 'visual.edges/v0': { routing: 'orthogonal' } },
} as SpatialCanvas

const base: SpatialLayoutOptions = { measure, parseBody, appearance }

/** A core that answers exactly what the TypeScript composition does, counting its calls. */
function agreeingCore() {
  let calls = 0
  const routing: RoutingCore = {
    routeLayout(nodes, edges, styleOf, overrides, budget, labels) {
      calls += 1
      const anchors = assignEdgeAnchors(nodes, edges, styleOf, overrides, budget, labels)
      const routes = edges.map((edge) =>
        routeEdge(nodes, edge, styleOf(edge), anchors.get(edge.id), undefined, budget, labels),
      )
      return { routes, anchors }
    },
  }
  return { routing, calls: () => calls }
}

/** The same core, its first route's last point moved by `dx`. */
function skewedCore(dx: number): RoutingCore {
  const { routing } = agreeingCore()
  return {
    routeLayout(...args) {
      const answer = routing.routeLayout(...args)
      const [first, ...rest] = answer.routes
      const path = (first as ResolvedEdgeNode).path
      const last = path.at(-1) as { x: number; y: number }
      const moved = { ...first, path: [...path.slice(0, -1), { x: last.x + dx, y: last.y }] }
      return { routes: [moved as ResolvedEdgeNode, ...rest], anchors: answer.anchors }
    },
  }
}

function layout(routing: RoutingCore | undefined, impl: CoreImpl) {
  const mismatches: CoreMismatch[] = []
  const core: LayoutCore | undefined =
    routing === undefined
      ? undefined
      : { routing, impl: { routeLayout: impl }, onMismatch: (m) => mismatches.push(m) }
  const laid = layoutSpatialCanvasWithAnchors(canvas, { ...base, ...(core ? { core } : {}) })
  return { ...laid, mismatches }
}

const edgesOf = (nodes: readonly SceneNode[]) =>
  nodes.filter((n): n is ResolvedEdgeNode => n.kind === 'edge')

describe('the routing core switch', () => {
  const reference = layout(undefined, 'ts')

  it('runs the TypeScript alone, never the core, under ts', () => {
    const core = agreeingCore()
    const laid = layout(core.routing, 'ts')
    expect(core.calls()).toBe(0)
    expect(laid.scene).toEqual(reference.scene)
  })

  it('answers with the core under rust, its routes and its anchors', () => {
    const laid = layout(skewedCore(7), 'rust')
    const [first] = edgesOf(laid.scene.nodes)
    const [expected] = edgesOf(reference.scene.nodes)
    expect(first?.path.at(-1)?.x).toBe((expected?.path.at(-1)?.x as number) + 7)
    expect(laid.mismatches).toEqual([])
    expect([...laid.anchors]).toEqual([...reference.anchors])
  })

  it('answers with the TypeScript under differential, reporting nothing when the two agree', () => {
    const core = agreeingCore()
    const laid = layout(core.routing, 'differential')
    expect(core.calls()).toBe(1)
    expect(laid.mismatches).toEqual([])
    expect(laid.scene).toEqual(reference.scene)
  })

  it('reports where a differing core parts from the TypeScript, with what reproduces it', () => {
    const laid = layout(skewedCore(1e-9), 'differential')
    expect(laid.scene).toEqual(reference.scene)
    expect(laid.mismatches).toHaveLength(1)
    const [mismatch] = laid.mismatches
    if (mismatch?.kind !== 'differs' || mismatch.fn !== 'routeLayout')
      throw new Error(`expected a routing difference, got ${mismatch?.fn} ${mismatch?.kind}`)
    // The one number moved, and nothing before it: the route's last x.
    expect(mismatch.rust[mismatch.at]).toBe((mismatch.ts[mismatch.at] as number) + 1e-9)
    expect(mismatch.repro.edges.map((e) => e.id)).toEqual(['e1', 'e2'])
    expect(mismatch.repro.styles).toEqual(['orthogonal', 'orthogonal'])
    expect(mismatch.repro.nodes).toBe(canvas.nodes)
  })

  it('reports a core whose routes agree but whose anchors do not', () => {
    const { routing } = agreeingCore()
    const misplaced: RoutingCore = {
      routeLayout(...args) {
        const answer = routing.routeLayout(...args)
        const anchors = new Map(answer.anchors)
        anchors.set('e2', { ...anchors.get('e2'), fromLaneDepth: 3 })
        return { routes: answer.routes, anchors }
      },
    }
    const laid = layout(misplaced, 'differential')
    expect(laid.scene).toEqual(reference.scene)
    expect(laid.mismatches.map((m) => m.kind)).toEqual(['differs'])
  })

  it('hands the core a budget of its own, so what it spends never reaches the TypeScript', () => {
    const { routing } = agreeingCore()
    const draining: RoutingCore = {
      routeLayout(nodes, edges, styleOf, overrides, budget, labels) {
        const answer = routing.routeLayout(nodes, edges, styleOf, overrides, budget, labels)
        budget.grid = 0
        budget.trials = 0
        return answer
      },
    }
    const laid = layout(draining, 'differential')
    expect(laid.scene).toEqual(reference.scene)
    // The accounts the core left differ from the TypeScript's: reported, as a difference.
    expect(laid.mismatches.map((m) => m.kind)).toEqual(['differs'])
  })

  it.each([
    'rust',
    'differential',
  ] as const)('reports a core that throws under %s, and the TypeScript answers', (impl) => {
    const failure = new Error('refused')
    const throwing: RoutingCore = {
      routeLayout: () => {
        throw failure
      },
    }
    const laid = layout(throwing, impl)
    expect(laid.scene).toEqual(reference.scene)
    expect(laid.mismatches).toEqual([
      expect.objectContaining({ fn: 'routeLayout', kind: 'refused', err: failure }),
    ])
  })
})
