import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { visualRenderContribution } from '@kamiazya/whiteboard-plugin-visual/render'
import { describe, expect, it } from 'vitest'
import { createFakeMeasure } from '../../test-utils/fake-measure.js'
import { layoutSpatialCanvas } from '../spatial-canvas.js'

const APPEARANCE = {
  resolveNode: () => ({}),
  resolveEdge: () => ({}),
  resolveLabel: () => ({}),
}

function labelRun(
  kind: string | undefined,
  w: number,
  h: number,
  facets?: Record<string, unknown>,
) {
  const canvas: SpatialCanvas = {
    nodes: [
      textNode({
        id: 'n',
        x: 0,
        y: 0,
        width: w,
        height: h,
        text: 'Events DB',
        facets: { ...(kind === undefined ? {} : { 'visual.shape/v0': { kind } }), ...facets },
      }),
    ],
    edges: [],
  }
  const scene = layoutSpatialCanvas(canvas, {
    measure: createFakeMeasure(),
    appearance: APPEARANCE,
    renderContributions: [visualRenderContribution],
  })
  const paragraph = scene.nodes.find((n) => n.kind === 'paragraph')
  const run = paragraph?.kind === 'paragraph' ? paragraph.runs[0] : undefined
  if (run === undefined) throw new Error('no text run in the scene')
  return run.bbox
}

describe('text inside a shaped node', () => {
  it.each([
    'octagon',
    'parallelogram',
    'ellipse',
    'cylinder',
  ])('a %s centres a short label across its width', (kind) => {
    const run = labelRun(kind, 200, 80)
    expect(run.x + run.w / 2).toBeCloseTo(100, 0)
  })

  it('a short cylinder centres its label between the caps', () => {
    // ry = min(0.1 * 140, 60 / 4) = 14: the lid's front rim dips to 28 and the
    // bottom bulge starts at 46, so the interior centre is 37.
    const run = labelRun('cylinder', 140, 60)
    expect(run.y + run.h / 2).toBeCloseTo(37, 0)
  })

  it('a plain rectangle keeps its label at the left, on top', () => {
    const run = labelRun(undefined, 200, 80)
    expect(run.x).toBeLessThan(20)
    expect(run.y).toBeLessThan(20)
  })
})
