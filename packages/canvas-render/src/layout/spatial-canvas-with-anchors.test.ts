import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { assignEdgeAnchors } from './edges/spatial-edges.js'
import type { SpatialLayoutOptions } from './spatial-canvas.js'
import { layoutSpatialCanvas, layoutSpatialCanvasWithAnchors } from './spatial-canvas.js'

const measure = () => ({ advanceWidth: 12, ascent: 10, descent: 2, lineGap: 0 })
const parseBody = () => ({ type: 'root' as const, children: [] })
const appearance = {
  resolveNode: () => ({ radius: 8 }),
  resolveEdge: () => ({ stroke: '#606060', strokeWidth: 1.5 }),
  resolveLabel: () => ({ fill: '#303030', fontFamily: 'sans-serif' }),
}

const canvas: SpatialCanvas = {
  nodes: [
    { id: 'a', type: 'text', x: 0, y: 0, width: 120, height: 60, text: 'a' },
    { id: 'b', type: 'text', x: 400, y: 0, width: 120, height: 60, text: 'b' },
    { id: 'c', type: 'text', x: 200, y: 300, width: 120, height: 60, text: 'c' },
  ],
  edges: [
    { id: 'e1', fromNode: 'a', toNode: 'b' },
    { id: 'e2', fromNode: 'b', toNode: 'c' },
  ],
  'x-whiteboard': { edgeRouting: { style: 'orthogonal' } },
} as SpatialCanvas

const options: SpatialLayoutOptions = { measure, parseBody, appearance }

describe('layoutSpatialCanvasWithAnchors', () => {
  it('returns the scene layoutSpatialCanvas would produce, unchanged', () => {
    const { scene } = layoutSpatialCanvasWithAnchors(canvas, options)
    expect(scene).toEqual(layoutSpatialCanvas(canvas, options))
  })

  it('returns the anchor map the layout itself routed with', () => {
    // The whole point: a caller holding the scene should never re-run the
    // anchor pass (it is the most expensive part of a drag start) — the
    // layout already computed it, so it travels out alongside the scene.
    const { anchors } = layoutSpatialCanvasWithAnchors(canvas, options)
    const expected = assignEdgeAnchors(canvas.nodes, canvas.edges, 'orthogonal')
    expect([...anchors.entries()]).toEqual([...expected.entries()])
  })
})
