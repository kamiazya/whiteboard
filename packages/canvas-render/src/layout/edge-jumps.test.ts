// Line jumps (x-whiteboard.edgeRouting.lineJumps): where one edge crosses
// another, the LATER edge (document order — the one painted on top) hops
// over the earlier one with a small arc, so crossing lines stay readable.
// Canvas-wide today; the per-edge override slot reuses the same resolution.
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import type { MdastRoot } from '@kamiazya/whiteboard-canvas-model/mdast'
import { describe, expect, it } from 'vitest'
import type { ResolvedEdgeNode } from '../scene-graph.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import type { SpatialAppearanceResolver } from './spatial-appearance.js'
import { layoutSpatialCanvas } from './spatial-canvas.js'

const measure = createFakeMeasure()
const fakeAppearance: SpatialAppearanceResolver = {
  resolveNode: () => ({}),
  resolveEdge: () => ({ stroke: '#606060' }),
  resolveLabel: () => ({ fill: '#303030', fontFamily: 'sans-serif' }),
}
const fakeGeometry = { paddingPx: 8, labelFontSizePx: 12, minContentWidthPx: 1 }
const fakeParseBody = (text: string): MdastRoot => ({
  type: 'root',
  children: [{ type: 'paragraph', children: [{ type: 'text', value: text }] }],
})

// A clean cross: e1 runs horizontally, e2 vertically over it at (225, 100).
// No node stands in either path, so both routes are direct segments.
const cross = (lineJumps?: 'none' | 'arc'): SpatialCanvas => ({
  nodes: [
    { id: 'a', type: 'text', x: 0, y: 75, width: 50, height: 50, text: 'a' },
    { id: 'b', type: 'text', x: 400, y: 75, width: 50, height: 50, text: 'b' },
    { id: 'c', type: 'text', x: 200, y: 0, width: 50, height: 50, text: 'c' },
    { id: 'd', type: 'text', x: 200, y: 300, width: 50, height: 50, text: 'd' },
  ],
  edges: [
    { id: 'e1', fromNode: 'a', toNode: 'b' },
    { id: 'e2', fromNode: 'c', toNode: 'd' },
  ],
  ...(lineJumps !== undefined ? { 'x-whiteboard': { edgeRouting: { lineJumps } } } : {}),
})

const options = () => ({
  measure,
  parseBody: fakeParseBody,
  appearance: fakeAppearance,
  geometry: fakeGeometry,
})

const edgeById = (nodes: readonly unknown[], id: string) =>
  (nodes as readonly { kind?: string; id?: string }[]).find(
    (n) => n.kind === 'edge' && n.id === id,
  ) as ResolvedEdgeNode | undefined

describe('line jumps', () => {
  it('the later edge hops over the earlier one at their crossing', () => {
    const scene = layoutSpatialCanvas(cross('arc'), options())
    expect(edgeById(scene.nodes, 'e2')?.jumps).toEqual([{ segment: 0, x: 225, y: 100 }])
    expect(edgeById(scene.nodes, 'e1')?.jumps).toBeUndefined()
  })

  it('absent or none leaves every edge jump-free', () => {
    for (const canvas of [cross(), cross('none')]) {
      const scene = layoutSpatialCanvas(canvas, options())
      expect(edgeById(scene.nodes, 'e1')?.jumps).toBeUndefined()
      expect(edgeById(scene.nodes, 'e2')?.jumps).toBeUndefined()
    }
  })

  it('crossings closer than a hop diameter coalesce to the first', () => {
    // Two vertical edges 6px apart cross one horizontal edge: separate arcs
    // cannot fit (radius 5), and emitting both would draw a backward path
    // between overlapping hops. The first crossing keeps its hop.
    const tight: SpatialCanvas = {
      nodes: [
        { id: 'a', type: 'text', x: 0, y: 75, width: 50, height: 50, text: 'a' },
        { id: 'b', type: 'text', x: 400, y: 75, width: 50, height: 50, text: 'b' },
        { id: 'c1', type: 'text', x: 172, y: 0, width: 50, height: 50, text: 'c1' },
        { id: 'd1', type: 'text', x: 172, y: 300, width: 50, height: 50, text: 'd1' },
        { id: 'c2', type: 'text', x: 178, y: 0, width: 50, height: 50, text: 'c2' },
        { id: 'd2', type: 'text', x: 178, y: 300, width: 50, height: 50, text: 'd2' },
      ],
      edges: [
        { id: 'v1', fromNode: 'c1', toNode: 'd1' },
        { id: 'v2', fromNode: 'c2', toNode: 'd2' },
        { id: 'h', fromNode: 'a', toNode: 'b' },
      ],
      'x-whiteboard': { edgeRouting: { lineJumps: 'arc' } },
    }
    const scene = layoutSpatialCanvas(tight, options())
    const jumps = edgeById(scene.nodes, 'h')?.jumps
    expect(jumps).toHaveLength(1)
    expect(jumps?.[0]).toMatchObject({ x: 197 })
  })

  it('shared endpoints never count as crossings', () => {
    // Two edges fanning out of the same node touch at the source border —
    // that contact is a junction, not a crossing to hop over.
    const fan: SpatialCanvas = {
      nodes: [
        { id: 'hub', type: 'text', x: 0, y: 100, width: 50, height: 50, text: 'hub' },
        { id: 'p', type: 'text', x: 300, y: 0, width: 50, height: 50, text: 'p' },
        { id: 'q', type: 'text', x: 300, y: 200, width: 50, height: 50, text: 'q' },
      ],
      edges: [
        { id: 'f1', fromNode: 'hub', toNode: 'p' },
        { id: 'f2', fromNode: 'hub', toNode: 'q' },
      ],
      'x-whiteboard': { edgeRouting: { lineJumps: 'arc' } },
    }
    const scene = layoutSpatialCanvas(fan, options())
    expect(edgeById(scene.nodes, 'f2')?.jumps).toBeUndefined()
  })
})
