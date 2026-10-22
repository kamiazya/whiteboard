// A resolved thread's bubble on the canvas: collapsed to its first line and
// labelled, so an open conversation is the only one that shows its whole text.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import type { SceneNode, ShapeSceneNode, TextRunNode } from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import type { SpatialAppearanceResolver } from '../theme/spatial-appearance.js'
import { layoutSpatialCanvas, type SpatialLayoutOptions } from './spatial-canvas.js'

const appearance: SpatialAppearanceResolver = {
  resolveNode: () => ({ radius: 4 }),
  resolveEdge: () => ({ stroke: '#606060' }),
  resolveLabel: () => ({ fill: '#303030', fontFamily: 'sans-serif' }),
  resolveComment: () => ({
    pin: { fill: '#d97706' },
    bubble: { fill: '#fef3c7', stroke: '#d97706' },
    leader: { stroke: '#d97706' },
    resolvedOverlay: {
      pin: { fill: '#d97706', fillOpacity: 0.45 },
      bubble: { fill: '#fef3c7', stroke: '#6b7280', fillOpacity: 0.45 },
      leader: { stroke: '#6b7280' },
      text: { fill: '#6b7280', fontFamily: 'sans-serif' },
    },
  }),
}

function baseOptions(overrides: Partial<SpatialLayoutOptions> = {}): SpatialLayoutOptions {
  return {
    measure: createFakeMeasure(),
    parseBody: (text: string): MdastRoot => ({
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'text', value: text }] }],
    }),
    appearance,
    geometry: { paddingPx: 8, labelFontSizePx: 14, minContentWidthPx: 1 },
    ...overrides,
  }
}

const canvasWith = (comments: SpatialCanvas['comments']) =>
  ({
    nodes: [textNode({ id: 'n1', x: 0, y: 0, width: 200, height: 100, text: 'content' })],
    edges: [],
    comments,
  }) satisfies SpatialCanvas

const bubbleOf = (nodes: readonly SceneNode[], id: string): ShapeSceneNode | undefined =>
  nodes.find((n): n is ShapeSceneNode => n.kind === 'shape' && n.id === `${id}/bubble`)

function runsOf(nodes: readonly SceneNode[]): TextRunNode[] {
  return nodes.flatMap((node) => {
    if (node.kind === 'textRun') return [node]
    if (node.kind === 'paragraph' || node.kind === 'heading') return [...node.runs]
    return []
  })
}

describe('comment layer', () => {
  describe('a resolved bubble', () => {
    const LONG = 'first line of the thread that is long enough to wrap onto a second line here'
    const resolvedScene = (text: string) =>
      layoutSpatialCanvas(
        canvasWith([{ id: 'c2', x: 400, y: 60, text, resolved: true }]),
        baseOptions({ showResolved: true }),
      )

    it('collapses to the first line and names itself Resolved, painted in the muted text', () => {
      const scene = resolvedScene(LONG)
      const bubbleBox = bubbleOf(scene.nodes, 'c2')?.bbox
      const runs = runsOf(scene.nodes).filter(
        (run) => bubbleBox !== undefined && run.bbox.y >= bubbleBox.y,
      )
      const bodyRuns = runs.filter((run) => run.text !== 'Resolved')
      const label = runs.find((run) => run.text === 'Resolved')
      expect(label).toBeDefined()
      expect(new Set(bodyRuns.map((run) => run.bbox.y)).size).toBe(1)
      expect(bodyRuns.length).toBeGreaterThan(0)
      expect(bodyRuns.map((run) => run.text).join(' ').length).toBeLessThan(LONG.length)
      expect(bodyRuns.every((run) => run.appearance?.fill === '#6b7280')).toBe(true)
      expect(label?.appearance?.fill).toBe('#6b7280')
      expect(label?.bbox.y).toBeGreaterThan(bodyRuns[0]?.bbox.y ?? Number.POSITIVE_INFINITY)
    })

    it('is shorter than the same text open, and the label sits inside the bubble', () => {
      const open = layoutSpatialCanvas(
        canvasWith([{ id: 'c2', x: 400, y: 60, text: LONG }]),
        baseOptions(),
      )
      const bubble = bubbleOf(resolvedScene(LONG).nodes, 'c2')
      const openBubble = bubbleOf(open.nodes, 'c2')
      const label = runsOf(resolvedScene(LONG).nodes).find((run) => run.text === 'Resolved')
      expect(bubble?.bbox.h).toBeLessThan(openBubble?.bbox.h ?? 0)
      expect((label?.bbox.y ?? 0) + (label?.bbox.h ?? 0)).toBeLessThanOrEqual(
        (bubble?.bbox.y ?? 0) + (bubble?.bbox.h ?? 0),
      )
    })

    it('leaves an open thread with no label and its full text unpainted by the overlay', () => {
      const open = layoutSpatialCanvas(
        canvasWith([{ id: 'c1', x: 400, y: 60, text: LONG }]),
        baseOptions({ showResolved: true }),
      )
      const runs = runsOf(open.nodes)
      expect(runs.some((run) => run.text === 'Resolved')).toBe(false)
      expect(runs.some((run) => run.appearance?.fill === '#6b7280')).toBe(false)
      expect(open).toEqual(
        layoutSpatialCanvas(canvasWith([{ id: 'c1', x: 400, y: 60, text: LONG }]), baseOptions()),
      )
    })
  })
})
