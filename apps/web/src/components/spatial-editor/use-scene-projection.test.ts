/**
 * The overview is chrome the editor draws itself, so it resolves colour the
 * way the committed scene does (ADR-0030): a preset node's box takes the
 * accent of the palette the BOARD is drawn in, not the bundled one.
 *
 * This hook took a `style` and no longer does — the chain that carried the
 * session override into the editor went with the Display panel's **Draw as**
 * row (ADR-0030 decision 6's 2026-09-11 addendum). What it must still do is
 * resolve through the canvas's OWN theme, which is what the two cases below
 * separate: a themed board and an unthemed one cannot answer the same.
 */
import { resolveCanvasPalette, SPATIAL_LIGHT_PALETTE } from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { indexNodeBoxes } from '../../lib/spatial/geometry.js'
import { useSceneProjection } from './use-scene-projection.js'

const preset = {
  id: 'a',
  type: 'text',
  x: 0,
  y: 0,
  width: 120,
  height: 60,
  text: 'a',
  color: '1',
} as const

const neon: SpatialCanvas = {
  nodes: [preset],
  edges: [],
  'x-whiteboard': { facets: { 'visual.theme/v0': { theme: 'visual.neon' } } },
}

const plain: SpatialCanvas = { nodes: [preset], edges: [] }

function projection(canvas: SpatialCanvas) {
  return renderHook(() =>
    useSceneProjection({
      scene: { nodes: [] },
      bounds: { x: 0, y: 0, w: 120, h: 60 },
      boxes: indexNodeBoxes(canvas),
      canvas,
      theme: 'light',
      selectedId: null,
      extraIds: new Set<string>(),
    }),
  ).result.current
}

describe('useSceneProjection minimap colour', () => {
  it('resolves a preset box through the theme the board names', () => {
    const themed = resolveCanvasPalette(neon, 'light')
    // Non-vacuous: the theme's preset-1 accent is a different hue from the
    // bundled one, so reading the wrong palette is visible here.
    expect(themed.presets['1'].stroke).not.toBe(SPATIAL_LIGHT_PALETTE.presets['1'].stroke)
    expect(projection(neon).minimapNodes[0]?.color).toBe(themed.presets['1'].stroke)
  })

  it('falls back to the bundled accent on a board that names no theme', () => {
    expect(projection(plain).minimapNodes[0]?.color).toBe(SPATIAL_LIGHT_PALETTE.presets['1'].stroke)
  })
})
