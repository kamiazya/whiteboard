// The palette a canvas is DRAWN in, for an editor chrome that previews it —
// the six preset swatches in a colour picker must show the strokes the theme
// will actually paint, or the picker lies about every pick (ADR-0030).
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { SPATIAL_DARK_PALETTE, SPATIAL_LIGHT_PALETTE } from '../theme/spatial-palette.js'
import { resolveCanvasPalette, resolveCanvasThemeFontFamily } from './spatial-canvas.js'

const canvasIn = (theme: string | undefined): SpatialCanvas => ({
  nodes: [],
  edges: [],
  ...(theme === undefined ? {} : { 'x-whiteboard': { facets: { 'visual.theme/v0': { theme } } } }),
})

describe('resolveCanvasPalette', () => {
  it('a canvas naming no theme draws in the bundled palette for the mode', () => {
    expect(resolveCanvasPalette(canvasIn(undefined), 'light')).toBe(SPATIAL_LIGHT_PALETTE)
    expect(resolveCanvasPalette(canvasIn(undefined), 'dark')).toBe(SPATIAL_DARK_PALETTE)
  })

  it("a canvas naming a bundled theme draws in that theme's palette for the mode", () => {
    const dark = resolveCanvasPalette(canvasIn('visual.neon'), 'dark')
    expect(dark.surface).toBe('#030711')
    expect(dark.presets['1'].stroke).not.toBe(SPATIAL_DARK_PALETTE.presets['1'].stroke)
    const light = resolveCanvasPalette(canvasIn('visual.neon'), 'light')
    expect(light.surface).toBe('#f8fafc')
  })

  it('follows the style the canvas is drawn under: clean is the bundled palette, a theme id that theme', () => {
    // The paper and the swatches preview what the layout DRAWS, and under a
    // session override that is not the saved theme.
    expect(resolveCanvasPalette(canvasIn('visual.neon'), 'dark', { style: 'clean' })).toBe(
      SPATIAL_DARK_PALETTE,
    )
    expect(
      resolveCanvasPalette(canvasIn(undefined), 'dark', { style: 'visual.neon' }).surface,
    ).toBe('#030711')
    expect(
      resolveCanvasPalette(canvasIn('visual.neon'), 'dark', { style: 'document' }).surface,
    ).toBe('#030711')
  })

  it('a theme nothing registered falls back to the bundled palette, like the layout does', () => {
    expect(resolveCanvasPalette(canvasIn('nobody.home'), 'light')).toBe(SPATIAL_LIGHT_PALETTE)
  })
})

describe('resolveCanvasThemeFontFamily', () => {
  it('answers the family the theme a style resolves to names, and nothing when it names none', () => {
    expect(resolveCanvasThemeFontFamily(canvasIn('visual.sketch'), { style: 'document' })).toBe(
      'Yomogi',
    )
    // neon draws in the bundled family, so there is nothing to fetch.
    expect(
      resolveCanvasThemeFontFamily(canvasIn('visual.neon'), { style: 'document' }),
    ).toBeUndefined()
    expect(resolveCanvasThemeFontFamily(canvasIn(undefined), { style: 'visual.sketch' })).toBe(
      'Yomogi',
    )
  })

  it('absent style is clean, unlike resolveCanvasPalette: a caller must ASK for the document look', () => {
    // The two differ deliberately. A palette is asked for by an editor that
    // is already drawing the document; this is asked by a tool echoing a
    // caller's `style`, where absent means the bundled look.
    expect(resolveCanvasThemeFontFamily(canvasIn('visual.sketch'))).toBeUndefined()
    expect(
      resolveCanvasThemeFontFamily(canvasIn('visual.sketch'), { style: 'clean' }),
    ).toBeUndefined()
  })
})
