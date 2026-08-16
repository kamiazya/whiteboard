// Global crossing minimization: per-edge side choices are heuristic
// guesses; a bounded improvement pass re-evaluates them against the WHOLE
// routed configuration and adopts a strictly better one — so a crossing
// that exists only because two edges guessed conflicting sides gets
// routed away entirely, not merely jumped.
import type { CanvasEdge, SpatialNode } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { assignEdgeAnchors, routeEdge } from './spatial-edges.js'

const node = (id: string, x: number, y: number, width: number, height: number): SpatialNode => ({
  id,
  type: 'text',
  x,
  y,
  width,
  height,
  text: id,
})

type P = { x: number; y: number }
function segmentsCross(a1: P, a2: P, b1: P, b2: P): boolean {
  const d = (p: P, q: P, r: P) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
  const [d1, d2, d3, d4] = [d(b1, b2, a1), d(b1, b2, a2), d(a1, a2, b1), d(a1, a2, b2)]
  return d1 * d2 < 0 && d3 * d4 < 0
}
function crossings(a: readonly P[], b: readonly P[]): number {
  let count = 0
  for (let i = 1; i < a.length; i++)
    for (let j = 1; j < b.length; j++)
      if (segmentsCross(a[i - 1]!, a[i]!, b[j - 1]!, b[j]!)) count++
  return count
}

describe('crossing minimization', () => {
  it('routes away a crossing that only existed because of conflicting side guesses', () => {
    // The arrangement that kept one jumped crossing: both edges initially
    // guess Red's bottom, and orange's approach then cuts across red's
    // corridor. Re-siding orange (e.g. via Red's right) removes the
    // crossing entirely.
    const nodes = [
      node('red', 0, 100, 300, 120),
      node('yellow', 450, 290, 260, 130),
      node('cyan', 630, 610, 280, 160),
    ]
    const edges: CanvasEdge[] = [
      { id: 'e-orange', fromNode: 'yellow', toNode: 'red' },
      { id: 'e-red', fromNode: 'red', toNode: 'cyan' },
    ]
    const anchors = assignEdgeAnchors(nodes, edges, 'orthogonal')
    const orange = routeEdge(nodes, edges[0]!, 'orthogonal', anchors.get('e-orange'))
    const red = routeEdge(nodes, edges[1]!, 'orthogonal', anchors.get('e-red'))
    expect(crossings(orange.path, red.path)).toBe(0)
  })

  it('leaves a crossing-free configuration exactly as the heuristics chose it', () => {
    // Two independent aligned pairs: nothing to improve, nothing may move.
    const nodes = [
      node('a', 0, 0, 100, 100),
      node('b', 400, 20, 100, 100),
      node('c', 0, 300, 100, 100),
      node('d', 400, 320, 100, 100),
    ]
    const edges: CanvasEdge[] = [
      { id: 'e1', fromNode: 'a', toNode: 'b' },
      { id: 'e2', fromNode: 'c', toNode: 'd' },
    ]
    const anchors = assignEdgeAnchors(nodes, edges, 'orthogonal')
    const r1 = routeEdge(nodes, edges[0]!, 'orthogonal', anchors.get('e1'))
    const r2 = routeEdge(nodes, edges[1]!, 'orthogonal', anchors.get('e2'))
    expect(r1.fromSide).toBe('right')
    expect(r1.toSide).toBe('left')
    expect(r1.path).toHaveLength(2)
    expect(r2.path).toHaveLength(2)
  })
})

describe('frozen side overrides', () => {
  it('pins the listed edges to their given sides and skips optimization', () => {
    const nodes = [
      node('red', 0, 100, 300, 120),
      node('yellow', 450, 290, 260, 130),
      node('cyan', 630, 610, 280, 160),
    ]
    const edges: CanvasEdge[] = [
      { id: 'e-orange', fromNode: 'yellow', toNode: 'red' },
      { id: 'e-red', fromNode: 'red', toNode: 'cyan' },
    ]
    // Freeze the pre-optimization arrangement (both via Red's bottom): the
    // optimizer would re-side orange, so surviving sides prove the skip.
    const frozen = new Map([
      ['e-orange', { fromSide: 'left' as const, toSide: 'bottom' as const }],
      ['e-red', { fromSide: 'bottom' as const, toSide: 'left' as const }],
    ])
    const anchors = assignEdgeAnchors(nodes, edges, 'orthogonal', frozen)
    const orange = routeEdge(nodes, edges[0]!, 'orthogonal', anchors.get('e-orange'))
    const red = routeEdge(nodes, edges[1]!, 'orthogonal', anchors.get('e-red'))
    expect(orange.toSide).toBe('bottom')
    expect(red.fromSide).toBe('bottom')
  })
})

describe('edgeSideOverrides through layoutSpatialEdges', () => {
  it('threads the frozen sides through the layout entry point apps/web calls', async () => {
    const { layoutSpatialEdges } = await import('./spatial-canvas.js')
    const { createFakeMeasure } = await import('../test-utils/fake-measure.js')
    const canvas = {
      nodes: [
        node('red', 0, 100, 300, 120),
        node('yellow', 450, 290, 260, 130),
        node('cyan', 630, 610, 280, 160),
      ],
      edges: [
        { id: 'e-orange', fromNode: 'yellow', toNode: 'red' },
        { id: 'e-red', fromNode: 'red', toNode: 'cyan' },
      ],
      'x-whiteboard': { edgeRouting: { style: 'orthogonal' as const } },
    }
    const frozen = new Map([
      ['e-orange', { fromSide: 'left' as const, toSide: 'bottom' as const }],
      ['e-red', { fromSide: 'bottom' as const, toSide: 'left' as const }],
    ])
    const sceneNodes = layoutSpatialEdges(canvas, {
      measure: createFakeMeasure(),
      parseBody: () => ({ type: 'root' as const, children: [] }),
      appearance: { resolveNode: () => ({}), resolveEdge: () => ({}), resolveLabel: () => ({}) },
      edgeSideOverrides: frozen,
    })
    const orange = sceneNodes.find((n) => n.kind === 'edge' && n.id === 'e-orange')
    // Without the pass-through the optimizer re-sides orange away from
    // Red's bottom; the frozen side surviving proves the option reached
    // assignEdgeAnchors.
    expect(orange !== undefined && orange.kind === 'edge' && orange.toSide).toBe('bottom')
  })
})

describe('optimization gate', () => {
  const crossingPair = () => ({
    nodes: [
      node('red', 0, 100, 300, 120),
      node('yellow', 450, 290, 260, 130),
      node('cyan', 630, 610, 280, 160),
    ],
    edges: [
      { id: 'e-orange', fromNode: 'yellow', toNode: 'red' },
      { id: 'e-red', fromNode: 'red', toNode: 'cyan' },
    ] as CanvasEdge[],
  })

  /** Far-away disjoint pairs that add edge COUNT without touching the scene. */
  const padding = (count: number) => {
    const nodes: SpatialNode[] = []
    const edges: CanvasEdge[] = []
    for (let i = 0; i < count; i++) {
      nodes.push(
        node(`pa${i}`, 5000 + i * 400, 0, 100, 60),
        node(`pb${i}`, 5000 + i * 400, 300, 100, 60),
      )
      edges.push({ id: `pad${i}`, fromNode: `pa${i}`, toNode: `pb${i}` })
    }
    return { nodes, edges }
  }

  it('above the full-optimization size the worst offenders still get fixed', () => {
    // 41 edges used to fall off a cliff (no optimization at all); the
    // bounded pass now tries candidates for the highest-cost edges, so
    // the one crossing pair — the worst offenders by construction —
    // resolves exactly as it would on a small canvas.
    const base = crossingPair()
    const pad = padding(39) // 2 + 39 = 41 > FULL_OPT_MAX_EDGES
    const nodes = [...base.nodes, ...pad.nodes]
    const edges = [...base.edges, ...pad.edges]
    const anchors = assignEdgeAnchors(nodes, edges, 'orthogonal')
    const orange = routeEdge(nodes, edges[0]!, 'orthogonal', anchors.get('e-orange'))
    const red = routeEdge(nodes, edges[1]!, 'orthogonal', anchors.get('e-red'))
    expect(crossings(orange.path, red.path)).toBe(0)
  })

  it('past the hard gate the pass is skipped and the crossing persists', () => {
    const base = crossingPair()
    const pad = padding(199) // 2 + 199 = 201 > 200
    const nodes = [...base.nodes, ...pad.nodes]
    const edges = [...base.edges, ...pad.edges]
    const anchors = assignEdgeAnchors(nodes, edges, 'orthogonal')
    const orange = routeEdge(nodes, edges[0]!, 'orthogonal', anchors.get('e-orange'))
    const red = routeEdge(nodes, edges[1]!, 'orthogonal', anchors.get('e-red'))
    expect(crossings(orange.path, red.path)).toBeGreaterThan(0)
  })

  it('at the gate boundary the pass still runs and removes the crossing', () => {
    const base = crossingPair()
    const pad = padding(38) // 2 + 38 = 40 <= 40
    const nodes = [...base.nodes, ...pad.nodes]
    const edges = [...base.edges, ...pad.edges]
    const anchors = assignEdgeAnchors(nodes, edges, 'orthogonal')
    const orange = routeEdge(nodes, edges[0]!, 'orthogonal', anchors.get('e-orange'))
    const red = routeEdge(nodes, edges[1]!, 'orthogonal', anchors.get('e-red'))
    expect(crossings(orange.path, red.path)).toBe(0)
  })
})
