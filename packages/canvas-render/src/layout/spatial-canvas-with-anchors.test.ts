import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { describeMeasure } from '../measure.js'
import { testLayoutCore } from '../test-utils/test-layout-core.js'
import { createSpatialTheme } from '../theme/spatial-theme.js'
import { assignEdgeAnchors } from './edges/spatial-edges.js'
import type { SpatialLayoutOptions } from './spatial-canvas.js'
import { layoutSpatialCanvas, layoutSpatialCanvasWithAnchors } from './spatial-canvas.js'

const measure = describeMeasure(() => ({ advanceWidth: 12, ascent: 10, descent: 2, lineGap: 0 }), {
  kind: 'host',
})
const appearance = createSpatialTheme({ mode: 'light' })

const canvas: SpatialCanvas = {
  nodes: [
    textNode({ id: 'a', x: 0, y: 0, width: 120, height: 60, text: 'a' }),
    textNode({ id: 'b', x: 400, y: 0, width: 120, height: 60, text: 'b' }),
    textNode({ id: 'c', x: 200, y: 300, width: 120, height: 60, text: 'c' }),
  ],
  edges: [
    {
      id: 'e1',
      from: { node: 'a' },
      to: { node: 'b' },
    },
    {
      id: 'e2',
      from: { node: 'b' },
      to: { node: 'c' },
    },
  ],
  facets: { 'visual.edges/v0': { routing: 'orthogonal' } },
} as SpatialCanvas

const options: SpatialLayoutOptions = { core: testLayoutCore(), measure, appearance }

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
