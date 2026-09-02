// ADR-0025 decision 5: comment chrome stays out of sceneDigest. The editor
// needs hit-testable pin/bubble ids (suffixed, mirroring the shipped
// `${commentId}/leader` convention), and without a rule those ids would
// surface as phantom node entries — double-reporting what
// `wb_canvas_snapshot.comments` already publishes. This pins the invariant
// through a real canvas + comment layout, so it stays green whether the
// pin/bubble ids exist or not.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import { expect, it } from 'vitest'
import type { SpatialAppearanceResolver } from './layout/nodes/spatial-appearance.js'
import { layoutSpatialCanvas } from './layout/spatial-canvas.js'
import { sceneDigest } from './scene-digest.js'
import { createFakeMeasure } from './test-utils/fake-measure.js'

const appearance: SpatialAppearanceResolver = {
  resolveNode: () => ({}),
  resolveEdge: () => ({}),
  resolveLabel: () => ({ fill: '#000', fontFamily: 'sans-serif' }),
  resolveComment: () => ({
    pin: { fill: '#d97706' },
    bubble: { fill: '#fef3c7', stroke: '#d97706' },
    leader: { stroke: '#d97706' },
  }),
}

const parseBody = (text: string): MdastRoot => ({
  type: 'root',
  children: [{ type: 'paragraph', children: [{ type: 'text', value: text }] }],
})

const canvasWithOneCommentedNode: SpatialCanvas = {
  nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 60, text: 'n1' }],
  edges: [],
  'x-whiteboard': { comments: [{ id: 'c1', x: 400, y: 60, text: 'move this left' }] },
}

const digestOf = (canvas: SpatialCanvas) =>
  sceneDigest(
    layoutSpatialCanvas(canvas, {
      measure: createFakeMeasure(),
      parseBody,
      appearance,
      geometry: { paddingPx: 8, labelFontSizePx: 12, minContentWidthPx: 1 },
    }),
  )

it('reports exactly one entry — the document node — with an unresolved comment on the canvas', () => {
  const digest = digestOf(canvasWithOneCommentedNode)
  expect(digest.nodes).toHaveLength(1)
  expect(digest.nodes[0]?.id).toBe('n1')
  expect(digest.overlaps).toEqual([])
  expect(digest.containment).toEqual([])
})
