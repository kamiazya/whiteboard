// @vitest-environment node
/**
 * The draft bubble wears the SAME comment chrome the renderer draws the
 * settled bubble with (ADR-0030): on a themed board that is the theme's
 * `comment.bubble`, so the draft and the comment it becomes are one object.
 */
import { resolveCanvasPalette, SPATIAL_DARK_PALETTE } from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { commentComposeStyle } from './comment-compose-overlay.js'

const neon: SpatialCanvas = {
  nodes: [],
  edges: [],
  'x-whiteboard': { facets: { 'visual.theme/v0': { theme: 'visual.neon' } } },
}

describe('commentComposeStyle', () => {
  it("carries the theme's own comment bubble on a board drawn in it", () => {
    const themed = resolveCanvasPalette(neon, 'dark', { style: 'document' })
    // Non-vacuous: neon's bubble is a different card from the bundled one,
    // so a style built off the bundled palette is visible here.
    expect(themed.comment.bubble.fill).not.toBe(SPATIAL_DARK_PALETTE.comment.bubble.fill)
    const style = commentComposeStyle(themed)
    expect(style.background).toBe(themed.comment.bubble.fill)
    expect(style.border).toBe(`1px solid ${themed.comment.bubble.stroke}`)
    expect(style.color).toBe(themed.labelFill)
  })

  it('keeps the bundled chrome for a board that names no theme', () => {
    const style = commentComposeStyle(resolveCanvasPalette({ nodes: [], edges: [] }, 'dark'))
    expect(style.background).toBe(SPATIAL_DARK_PALETTE.comment.bubble.fill)
    expect(style.color).toBe(SPATIAL_DARK_PALETTE.labelFill)
  })
})
