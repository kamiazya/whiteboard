// Anchor fan-out: JSON Canvas lets an author pick an edge end's SIDE but
// never its position along that side, so when several edge ends share one
// (node, side) the renderer is free to spread them. Stacked ends at the
// side midpoint made two edges with different colors/arrowheads read as
// one line — the anchors now distribute deterministically along the side.
import type { CanvasEdge, SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-canvas-model'
import { describe, expect, it } from 'vitest'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import type { SpatialAppearanceResolver } from './spatial-appearance.js'
import { layoutSpatialCanvas } from './spatial-canvas.js'
import { assignEdgeAnchors, routeEdge } from './spatial-edges.js'

const node = (id: string, x: number, y: number): SpatialNode => ({
  id,
  type: 'text',
  x,
  y,
  width: 100,
  height: 100,
  text: id,
})

const appearance: SpatialAppearanceResolver = {
  resolveNode: () => ({}),
  resolveEdge: () => ({}),
  resolveLabel: () => ({}),
}

const layoutOptions = {
  measure: createFakeMeasure(),
  parseBody: () => ({ type: 'root' as const, children: [] }),
  appearance,
}

describe('assignEdgeAnchors', () => {
  it('spreads two ends sharing a side at 1/3 and 2/3, ordered by the far endpoint', () => {
    const nodes = [node('c', 0, 0), node('a', 300, -100), node('b', 300, 100)]
    const edges: CanvasEdge[] = [
      { id: 'e1', fromNode: 'a', toNode: 'c' },
      { id: 'e2', fromNode: 'b', toNode: 'c' },
    ]
    const anchors = assignEdgeAnchors(nodes, edges)
    // Both edges arrive at c's right side; a sits above b, so e1 lands the
    // upper anchor — the two lines never cross right at the node.
    expect(anchors.get('e1')?.to?.x).toBeCloseTo(100)
    expect(anchors.get('e1')?.to?.y).toBeCloseTo(100 / 3)
    expect(anchors.get('e2')?.to?.x).toBeCloseTo(100)
    expect(anchors.get('e2')?.to?.y).toBeCloseTo(200 / 3)
    // The lone ends keep their side midpoints.
    expect(anchors.get('e1')?.from).toEqual({ x: 300, y: -50 })
    expect(anchors.get('e2')?.from).toEqual({ x: 300, y: 150 })
  })

  it('a single end on a side stays at the side midpoint', () => {
    const nodes = [node('a', 0, 0), node('b', 300, 0)]
    const anchors = assignEdgeAnchors(nodes, [{ id: 'e1', fromNode: 'a', toNode: 'b' }])
    expect(anchors.get('e1')?.from).toEqual({ x: 100, y: 50 })
    expect(anchors.get('e1')?.to).toEqual({ x: 300, y: 50 })
  })

  it('separates a bidirectional pair into parallel non-overlapping routes', () => {
    const nodes = [node('a', 0, 0), node('b', 300, 0)]
    const edges: CanvasEdge[] = [
      { id: 'e1', fromNode: 'a', toNode: 'b' },
      { id: 'e2', fromNode: 'b', toNode: 'a' },
    ]
    const anchors = assignEdgeAnchors(nodes, edges)
    const p1 = routeEdge(nodes, edges[0]!, 'straight', anchors.get('e1')).path
    const p2 = routeEdge(nodes, edges[1]!, 'straight', anchors.get('e2')).path
    expect(p1[0]?.y).toBeCloseTo(100 / 3)
    expect(p2[p2.length - 1]?.y).toBeCloseTo(200 / 3)
    // The two routes share no y — previously both ran along y=50.
    const ys1 = new Set(p1.map((p) => p.y))
    for (const p of p2) expect(ys1.has(p.y)).toBe(false)
  })

  it('honours an explicit authored side and fans along it', () => {
    const nodes = [node('c', 0, 0), node('a', 300, -100), node('b', 300, 100)]
    const edges: CanvasEdge[] = [
      { id: 'e1', fromNode: 'a', toNode: 'c', toSide: 'top' },
      { id: 'e2', fromNode: 'b', toNode: 'c', toSide: 'top' },
    ]
    const anchors = assignEdgeAnchors(nodes, edges)
    // Both on c's top edge (y = 0), spread along x; both far ends share
    // x = 350, so document order breaks the tie.
    expect(anchors.get('e1')?.to?.x).toBeCloseTo(100 / 3)
    expect(anchors.get('e1')?.to?.y).toBe(0)
    expect(anchors.get('e2')?.to?.x).toBeCloseTo(200 / 3)
    expect(anchors.get('e2')?.to?.y).toBe(0)
  })

  it('skips edges with a missing endpoint without disturbing the rest', () => {
    const nodes = [node('a', 0, 0), node('b', 300, 0)]
    const edges: CanvasEdge[] = [
      { id: 'ghost', fromNode: 'a', toNode: 'nope' },
      { id: 'e1', fromNode: 'a', toNode: 'b' },
    ]
    const anchors = assignEdgeAnchors(nodes, edges)
    expect(anchors.get('ghost')).toBeUndefined()
    expect(anchors.get('e1')?.from).toEqual({ x: 100, y: 50 })
  })
})

describe('anchor fan-out through layoutSpatialCanvas', () => {
  it('renders a bidirectional pair as two distinct parallel paths', () => {
    const canvas: SpatialCanvas = {
      nodes: [node('a', 0, 0), node('b', 300, 0)],
      edges: [
        { id: 'e1', fromNode: 'a', toNode: 'b' },
        { id: 'e2', fromNode: 'b', toNode: 'a' },
      ],
    }
    const scene = layoutSpatialCanvas(canvas, layoutOptions)
    const edgeNodes = scene.nodes.filter((n) => n.kind === 'edge')
    expect(edgeNodes).toHaveLength(2)
    const [r1, r2] = edgeNodes
    expect(r1?.path[0]?.y).not.toBeCloseTo(r2?.path[0]?.y ?? Number.NaN)
  })
})
