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
    resolvedOverlay: {
      pin: { fill: '#d97706', fillOpacity: 0.45 },
      bubble: { fill: '#fef3c7', stroke: '#d97706', fillOpacity: 0.45 },
      leader: { stroke: '#d97706', strokeOpacity: 0.45 },
    },
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

it('keeps the positional fallback for a comment-only canvas — excluded chrome counts as UNIDENTIFIED, not dropped', () => {
  // No document node carries an id here, so the comment's own pin/bubble ids
  // must not make `identified.length > 0` fire on their own — that would
  // switch this canvas from the positional fallback to a 0-entry digest,
  // changing behaviour for a canvas that never had an identified node at
  // all. Positional naming (n0, n1, ...) is unaffected either way, so this
  // is the same fallback a pre-ids scene already produced.
  const commentOnly: SpatialCanvas = {
    nodes: [],
    edges: [],
    'x-whiteboard': { comments: [{ id: 'c1', x: 400, y: 60, text: 'stray note' }] },
  }
  const digest = digestOf(commentOnly)
  expect(digest.nodes.every((n) => n.id.startsWith('n'))).toBe(true)
  expect(digest.nodes.length).toBeGreaterThan(0)
})
