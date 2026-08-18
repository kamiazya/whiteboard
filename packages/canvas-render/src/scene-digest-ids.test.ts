// The digest is what an AI reads to decide what to change, and the only way
// it can act on what it read is a `node.patch` op against a node id. Numbering
// the entries by array position gave it names that mean nothing outside the
// digest and that shift whenever a node is added or removed — the reader
// could see "these two overlap" and had no way to say which two.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import { expect, it } from 'vitest'
import type { SpatialAppearanceResolver } from './layout/spatial-appearance.js'
import { layoutSpatialCanvas } from './layout/spatial-canvas.js'
import { sceneDigest } from './scene-digest.js'
import { createFakeMeasure } from './test-utils/fake-measure.js'

const appearance: SpatialAppearanceResolver = {
  resolveNode: () => ({}),
  resolveEdge: () => ({}),
  resolveLabel: () => ({ fill: '#000', fontFamily: 'sans-serif' }),
}
const parseBody = (text: string): MdastRoot => ({
  type: 'root',
  children: [{ type: 'paragraph', children: [{ type: 'text', value: text }] }],
})

/** Fixed coordinates per id, so removing a node moves nothing that remains. */
const PLACES: Record<string, { x: number; y: number }> = {
  alpha: { x: 0, y: 0 },
  beta: { x: 40, y: 0 },
  gamma: { x: 300, y: 0 },
}

const canvasWith = (ids: readonly string[]): SpatialCanvas =>
  ({
    nodes: ids.map((id) => ({
      id,
      type: 'text',
      x: PLACES[id]?.x ?? 0,
      y: PLACES[id]?.y ?? 0,
      width: 100,
      height: 60,
      text: id,
    })),
    edges: [],
  }) as unknown as SpatialCanvas

const digestOf = (canvas: SpatialCanvas) =>
  sceneDigest(
    layoutSpatialCanvas(canvas, {
      measure: createFakeMeasure(),
      parseBody,
      appearance,
      geometry: { paddingPx: 8, labelFontSizePx: 12, minContentWidthPx: 1 },
    }),
  )

it('names each entry by its document node id', () => {
  const digest = digestOf(canvasWith(['alpha', 'beta', 'gamma']))
  expect(digest.nodes.map((n) => n.id)).toEqual(['alpha', 'beta', 'gamma'])
})

it('keeps a node its name when an earlier node is removed', () => {
  // Positional ids renamed gamma from n2 to n1 here, silently pointing any
  // instruction written against the first digest at a different node.
  const before = digestOf(canvasWith(['alpha', 'beta', 'gamma']))
  const after = digestOf(canvasWith(['beta', 'gamma']))
  expect(before.nodes.map((n) => n.id)).toEqual(['alpha', 'beta', 'gamma'])
  expect(after.nodes.map((n) => n.id)).toEqual(['beta', 'gamma'])
  expect(after.nodes.find((n) => n.id === 'gamma')?.bbox).toEqual(
    before.nodes.find((n) => n.id === 'gamma')?.bbox,
  )
})

it('reports one entry per canvas node, not one per laid-out box', () => {
  // Each node also lays out its text, which carries a bbox of its own. Those
  // are content inside a node, not nodes: reporting them made a three-node
  // canvas answer with six entries, each "contained in" another.
  expect(digestOf(canvasWith(['alpha', 'beta', 'gamma'])).nodes).toHaveLength(3)
  expect(digestOf(canvasWith(['alpha', 'beta', 'gamma'])).containment).toEqual([])
})

it('names overlap pairs by document id too', () => {
  // Two 100-wide boxes 40 apart overlap.
  const digest = digestOf(canvasWith(['alpha', 'beta']))
  expect(digest.overlaps).toEqual([['alpha', 'beta']])
})
