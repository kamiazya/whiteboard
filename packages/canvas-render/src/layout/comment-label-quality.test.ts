// The comment bubble's other debt: not what it covers of the NODES (the
// density scoreboard pins that) but what it covers of the words beside them.
// A container's name and an edge's label are text runs the layout places
// outside any node box, so a placer that only dodges nodes parks a bubble
// right on top of them.
//
// DEBT targets zero. The aggregate is pinned EXACTLY so that a change which
// moves it either way has to say why.

import type { CanvasComment, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import type { BoundingBox, Scene } from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import type { SpatialAppearanceResolver } from '../theme/spatial-appearance.js'
import { layoutSpatialCanvas } from './spatial-canvas.js'

const measure = createFakeMeasure()

const appearance: SpatialAppearanceResolver = {
  resolveNode: () => ({ radius: 4 }),
  resolveEdge: () => ({ stroke: '#606060', strokeWidth: 1.5 }),
  resolveLabel: () => ({ fill: '#303030', fontFamily: 'sans-serif' }),
  resolveComment: () => ({
    pin: { fill: '#d97706' },
    bubble: { fill: '#fef3c7', stroke: '#d97706' },
    leader: { stroke: '#d97706', strokeWidth: 1 },
    passage: { fill: '#d97706' },
    region: { fill: 'none', stroke: '#d97706' },
    pinCount: { fill: '#fef3c7' },
    resolvedOverlay: {
      pin: { fill: '#d97706' },
      bubble: { fill: '#fef3c7' },
      leader: { stroke: '#d97706' },
      passage: { fill: '#d97706' },
      region: { fill: 'none', stroke: '#d97706' },
      pinCount: { fill: '#fef3c7' },
    },
  }),
}

interface LabelCase {
  readonly name: string
  readonly canvas: SpatialCanvas
  readonly comments: readonly CanvasComment[]
}

const comment = (id: string, x: number, y: number): CanvasComment => ({
  id,
  x,
  y,
  text: 'looks right to me',
})

// The node's top-right corner is the comment's anchor, and the bubble's
// first choice (down-right) lies over the NEXT frame's name.
const frameName: LabelCase = {
  name: 'a frame name beside the first-choice side',
  canvas: {
    nodes: [
      groupNode({ id: 'a', x: 0, y: 0, width: 190, height: 330, label: 'Edge' }),
      textNode({ id: 'n', x: 20, y: 222, width: 150, height: 80, text: 'Gateway' }),
      groupNode({ id: 'b', x: 200, y: 280, width: 260, height: 200, label: 'Identity' }),
    ],
    edges: [],
  },
  comments: [comment('k', 170, 222)],
}

const edgeLabel: LabelCase = {
  name: 'an edge label beside the first-choice side',
  canvas: {
    nodes: [
      textNode({ id: 'n', x: 0, y: 0, width: 120, height: 60, text: 'Order Service' }),
      textNode({ id: 'm', x: 420, y: 0, width: 120, height: 60, text: 'Order DB' }),
    ],
    edges: [
      {
        id: 'e',
        from: { node: 'n', side: 'right', end: 'none' },
        to: { node: 'm', side: 'left', end: 'arrow' },
        label: 'reads and writes orders',
      },
    ],
  },
  comments: [comment('k', 120, 0)],
}

const CASES = [frameName, edgeLabel] as const

function labelBoxes(scene: Scene): BoundingBox[] {
  return scene.nodes.flatMap((node) =>
    node.kind === 'textRun' && node.annotates !== undefined ? [node.bbox] : [],
  )
}

function bubblesOf(scene: Scene): BoundingBox[] {
  return scene.nodes.flatMap((node) =>
    node.kind === 'shape' && node.commentChrome === true && node.id?.endsWith('/bubble') === true
      ? [node.bbox]
      : [],
  )
}

function overlap(a: BoundingBox, b: BoundingBox): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

function coveredLabelArea(entry: LabelCase): number {
  const scene = layoutSpatialCanvas(entry.canvas, {
    measure,
    appearance,
    parseBody: (text) => ({
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'text', value: text }] }],
    }),
    comments: entry.comments,
  })
  const labels = labelBoxes(scene)
  const bubbles = bubblesOf(scene)
  // The subject is present: a corpus whose labels or bubbles vanished would
  // score zero and read as a clean board.
  expect(labels.length, `${entry.name} labels`).toBeGreaterThan(0)
  expect(bubbles.length, `${entry.name} bubbles`).toBe(entry.comments.length)
  let sum = 0
  for (const bubble of bubbles) for (const label of labels) sum += overlap(bubble, label)
  return Math.round(sum)
}

describe('where a comment bubble stands against the words around it', () => {
  it('covers no frame name and no edge label on the labelled boards', () => {
    expect(Object.fromEntries(CASES.map((entry) => [entry.name, coveredLabelArea(entry)]))).toEqual(
      {
        'a frame name beside the first-choice side': 0,
        'an edge label beside the first-choice side': 0,
      },
    )
  })
})
