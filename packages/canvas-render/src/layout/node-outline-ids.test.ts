// The silhouette table is keyed by node id, so an id that names an
// Object.prototype member must find nothing there unless a facet put it
// there. One shaped node is enough to make the table exist at all.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import type { ParagraphBlockNode, ShapeSceneNode } from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { layoutSpatialCanvas, type SpatialLayoutOptions } from './spatial-canvas.js'

const PADDING_PX = 8

const OPTIONS: SpatialLayoutOptions = {
  measure: createFakeMeasure(),
  parseBody: () => ({
    type: 'root',
    children: [{ type: 'paragraph', children: [{ type: 'text', value: 'one line' }] }],
  }),
  appearance: { resolveNode: () => ({}), resolveEdge: () => ({}), resolveLabel: () => ({}) },
  geometry: { paddingPx: PADDING_PX, labelFontSizePx: 14, minContentWidthPx: 1 },
}

const SHAPED = {
  ...textNode({ id: 'a', x: 0, y: 0, width: 200, height: 100, text: 'one line' }),
  facets: { 'visual.shape/v0': { kind: 'ellipse' as const } },
}

describe('the silhouette table read by node id', () => {
  it.each([
    'constructor',
    'toString',
    '__proto__',
    'hasOwnProperty',
  ])('a node with id %s is unshaped beside a shaped one', (id) => {
    const plain = textNode({ id, x: 0, y: 300, width: 200, height: 100, text: 'one line' })
    const canvas: SpatialCanvas = { nodes: [SHAPED, plain], edges: [] }
    const scene = layoutSpatialCanvas(canvas, OPTIONS)
    const chrome = scene.nodes.find((n): n is ShapeSceneNode => n.kind === 'shape' && n.id === id)
    expect(chrome).toBeDefined()
    expect(chrome?.shape).toBeUndefined()
    const block = scene.nodes.find(
      (n): n is ParagraphBlockNode => n.kind === 'paragraph' && n.bbox.y >= 300,
    )
    expect(block?.bbox.y).toBe(300 + PADDING_PX)
  })
})
