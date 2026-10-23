// A frame's title sits above its top border, outside the box a node
// obstacle covers, so a label whose midpoint fell there landed on the title
// text. The title is something a label must not cover, the way a node is.
import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { TextRunNode } from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
import { createFakeMeasure } from '../../test-utils/fake-measure.js'
import { layoutSpatialCanvas } from '../spatial-canvas.js'

// The edge runs from a box above the frame into one inside it, straight down
// through the title's row; its midpoint lies on the title.
const board = (): SpatialCanvas => ({
  nodes: [
    groupNode({ id: 'tier', x: 0, y: 100, width: 400, height: 200, label: 'Presentation tier' }),
    textNode({ id: 'top', x: 60, y: -60, width: 100, height: 60, text: 'top' }),
    textNode({ id: 'inner', x: 60, y: 160, width: 100, height: 60, text: 'inner' }),
  ],
  edges: [{ id: 'down', from: { node: 'top' }, to: { node: 'inner' }, label: 'HTTPS' }],
})

const runs = (canvas: SpatialCanvas) =>
  layoutSpatialCanvas(canvas, {
    measure: createFakeMeasure(),
    parseBody: (text: string) => ({
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'text', value: text }] }],
    }),
    appearance: {
      resolveNode: () => ({}),
      resolveEdge: () => ({ stroke: '#606060' }),
      resolveLabel: () => ({ fill: '#303030', fontFamily: 'sans-serif' }),
    },
    geometry: { paddingPx: 8, labelFontSizePx: 12, minContentWidthPx: 1 },
  }).nodes.filter((n): n is TextRunNode => n.kind === 'textRun')

const overlap = (a: TextRunNode['bbox'], b: TextRunNode['bbox']) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

describe('an edge label beside a frame title', () => {
  it('does not cover the title', () => {
    const all = runs(board())
    const title = all.find((r) => r.annotates?.kind === 'node' && r.annotates.id === 'tier')
    const label = all.find((r) => r.annotates?.kind === 'edge')
    expect(title).toBeDefined()
    expect(label).toBeDefined()
    expect(overlap(title!.bbox, label!.bbox)).toBe(false)
  })

  it('still sits at the midpoint when the title is elsewhere', () => {
    const all = runs({
      ...board(),
      nodes: board().nodes.map((n) => (n.id === 'tier' ? { ...n, x: 300 } : n)),
    })
    const label = all.find((r) => r.annotates?.kind === 'edge')
    expect(label!.bbox.x + label!.bbox.w / 2).toBe(110)
  })
})
