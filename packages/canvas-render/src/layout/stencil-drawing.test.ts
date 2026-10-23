import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { applyStencil, VISUAL_STENCILS } from '@kamiazya/whiteboard-plugin-visual'
import { visualRenderContribution } from '@kamiazya/whiteboard-plugin-visual/render'
import { describe, expect, it } from 'vitest'
import { renderSceneToSvg } from '../svg/backend.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { layoutSpatialCanvas } from './spatial-canvas.js'

const APPEARANCE = {
  resolveNode: () => ({}),
  resolveEdge: () => ({}),
  resolveLabel: () => ({}),
}

const sceneOf = (node: SpatialCanvas['nodes'][number]) =>
  layoutSpatialCanvas(
    { nodes: [node], edges: [] },
    {
      measure: createFakeMeasure(),
      appearance: APPEARANCE,
      renderContributions: [visualRenderContribution],
    },
  )

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

  it.each(ids)('%s carries a badge, so the silhouette is not the only signal', (name) => {
    const dressed = applyStencil(plain, `visual.${name}`)
    if (dressed === undefined) throw new Error(`stencil visual.${name} is not registered`)
    const badges = sceneOf(dressed).nodes.filter((n) => n.kind === 'icon')
    expect(badges).toHaveLength(1)
    // An icon with no stroke is a `<use>` that draws nothing.
    expect(draw(dressed)).toMatch(/<use [^>]*stroke=/)
    // The mark sits inside the node, clear of the label's inscribed box.
    const [badge] = badges
    expect(badge?.bbox.x).toBeGreaterThanOrEqual(0)
    expect((badge?.bbox.x ?? 0) + (badge?.bbox.w ?? 0)).toBeLessThanOrEqual(200)
  })

  it('a box with a symbol but no stencil draws no badge', () => {
    const marked = { ...plain, facets: { 'visual.symbol/v0': { kind: 'icon', name: 'star' } } }
    expect(sceneOf(marked).nodes.some((n) => n.kind === 'icon')).toBe(false)
  })

  it('no two stencils draw the same', () => {
    const drawings = ids.map((name) => {
      const dressed = applyStencil(plain, `visual.${name}`)
      return dressed === undefined ? '' : draw(dressed)
    })
    expect(new Set(drawings).size).toBe(ids.length)
  })
})
