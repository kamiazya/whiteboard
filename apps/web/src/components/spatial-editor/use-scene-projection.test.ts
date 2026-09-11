/**
 * The overview is chrome the editor draws itself, so it resolves colour the
 * way the committed scene does (ADR-0030): a preset node's box takes the
 * accent of the palette the BOARD is drawn in, not the bundled one, and the
 * session's `style` decides which that is.
 */
import type { SpatialRenderStyle } from '@kamiazya/whiteboard-canvas-render'
import { resolveCanvasPalette, SPATIAL_LIGHT_PALETTE } from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { indexNodeBoxes } from '../../lib/spatial/geometry.js'
import { useSceneProjection } from './use-scene-projection.js'

const neon: SpatialCanvas = {
  nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 120, height: 60, text: 'a', color: '1' }],
  edges: [],
  facets: { 'visual.theme/v0': { theme: 'visual.neon' } },
}

function projection(canvas: SpatialCanvas, style: SpatialRenderStyle) {
  return renderHook(() =>
    useSceneProjection({
      scene: { nodes: [] },
      bounds: { x: 0, y: 0, w: 120, h: 60 },
      boxes: indexNodeBoxes(canvas),
      canvas,
      theme: 'light',
      style,
      selectedId: null,
      extraIds: new Set<string>(),
    }),
  ).result.current
}

describe('useSceneProjection minimap colour', () => {
  it("resolves a preset box through the theme the board names, under style 'document'", () => {
    const themed = resolveCanvasPalette(neon, 'light', { style: 'document' })
    // Non-vacuous: the theme's preset-1 accent is a different hue from the
    // bundled one, so reading the wrong palette is visible here.
    expect(themed.presets['1'].stroke).not.toBe(SPATIAL_LIGHT_PALETTE.presets['1'].stroke)
    expect(projection(neon, 'document').minimapNodes[0]?.color).toBe(themed.presets['1'].stroke)
  })

  it("falls back to the bundled accent under style 'clean', which names no theme", () => {
    expect(projection(neon, 'clean').minimapNodes[0]?.color).toBe(
      SPATIAL_LIGHT_PALETTE.presets['1'].stroke,
    )
  })
})
