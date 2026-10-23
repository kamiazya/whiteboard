import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { visualRenderContribution } from '@kamiazya/whiteboard-plugin-visual/render'
import { describe, expect, it } from 'vitest'
import { createFakeMeasure } from '../../test-utils/fake-measure.js'
import { layoutSpatialCanvas } from '../spatial-canvas.js'
import { outlineContentBox } from './node-outline.js'

const APPEARANCE = {
  resolveNode: () => ({}),
  resolveEdge: () => ({}),
  resolveLabel: () => ({}),
}

const KINDS = ['ellipse', 'diamond', 'hexagon', 'parallelogram', 'octagon', 'cylinder'] as const
const NODE = { x: 0, y: 0, w: 160, h: 100 }

function runsOf(kind: string, text: string) {
  const scene = layoutSpatialCanvas(
    {
      nodes: [
        textNode({
          id: 'n',
          x: NODE.x,
          y: NODE.y,
          width: NODE.w,
          height: NODE.h,
          text,
          facets: { 'visual.shape/v0': { kind } },
        }),
      ],
      edges: [],
    },
    {
      measure: createFakeMeasure(),
      appearance: APPEARANCE,
      renderContributions: [visualRenderContribution],
    },
  )
  const runs = scene.nodes.flatMap((n) => (n.kind === 'paragraph' ? n.runs : []))
  return { runs, scene }
}

describe.each(KINDS)('a label in a %s', (kind) => {
  const inscribed = outlineContentBox(`visual.${kind}`, NODE)

  it.each(['Payments API', 'API Gateway'])('"%s" stays inside the inscribed box', (text) => {
    const { runs } = runsOf(kind, text)
    // Nothing is dropped or split mid-word: the runs read back as the label.
    expect(runs.map((run) => run.text).join(' ')).toBe(text)
    for (const run of runs) {
      expect(run.bbox.x).toBeGreaterThanOrEqual(inscribed.x - 0.5)
      expect(run.bbox.x + run.bbox.w).toBeLessThanOrEqual(inscribed.x + inscribed.w + 0.5)
      expect(run.bbox.y).toBeGreaterThanOrEqual(inscribed.y - 0.5)
      expect(run.bbox.y + run.bbox.h).toBeLessThanOrEqual(inscribed.y + inscribed.h + 0.5)
    }
  })

  it('centres every wrapped line, not only the block', () => {
    const { runs } = runsOf(kind, 'Payments API')
    const centres = runs.map((r) => r.bbox.x + r.bbox.w / 2)
    for (const c of centres) expect(c).toBeCloseTo(centres[0] ?? 0, 0)
    expect(centres[0]).toBeCloseTo(inscribed.x + inscribed.w / 2, 0)
  })
})

it('the wrapped label is present as more than one line somewhere', () => {
  expect(KINDS.some((k) => runsOf(k, 'Payments API').runs.length > 1)).toBe(true)
})
