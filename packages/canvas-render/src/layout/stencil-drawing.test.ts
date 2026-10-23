import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { applyStencil, VISUAL_STENCILS } from '@kamiazya/whiteboard-plugin-visual'
import { visualRenderContribution } from '@kamiazya/whiteboard-plugin-visual/render'
import { describe, expect, it } from 'vitest'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { renderSceneToSvg } from '../svg/backend.js'
import { layoutSpatialCanvas } from './spatial-canvas.js'

const APPEARANCE = {
  resolveNode: () => ({}),
  resolveEdge: () => ({}),
  resolveLabel: () => ({}),
}

const draw = (node: SpatialCanvas['nodes'][number]): string =>
  renderSceneToSvg(
    layoutSpatialCanvas(
      { nodes: [node], edges: [] },
      {
        measure: createFakeMeasure(),
        appearance: APPEARANCE,
        renderContributions: [visualRenderContribution],
      },
    ),
  )

const plain = textNode({ id: 'n', x: 0, y: 0, width: 200, height: 80, text: 'Orders' })

describe('every bundled stencil is visible on the board', () => {
  const ids = Object.keys(VISUAL_STENCILS)

  it('the table is present', () => {
    expect(ids.length).toBeGreaterThanOrEqual(6)
  })

  it.each(ids)('%s draws differently from the plain box', (name) => {
    const dressed = applyStencil(plain, `visual.${name}`)
    if (dressed === undefined) throw new Error(`stencil visual.${name} is not registered`)
    expect(draw(dressed)).not.toBe(draw(plain))
  })

  it('no two stencils draw the same', () => {
    const drawings = ids.map((name) => {
      const dressed = applyStencil(plain, `visual.${name}`)
      return dressed === undefined ? '' : draw(dressed)
    })
    expect(new Set(drawings).size).toBe(ids.length)
  })
})
