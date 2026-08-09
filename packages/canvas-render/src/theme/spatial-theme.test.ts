import type { CanvasEdge, SpatialNode } from '@kamiazya/whiteboard-canvas-model'
import { describe, expect, it } from 'vitest'
import { SPATIAL_THEME_FONT_FAMILY } from './font-family.js'
import { SPATIAL_DARK_PALETTE, SPATIAL_LIGHT_PALETTE } from './spatial-palette.js'
import { createSpatialTheme } from './spatial-theme.js'

function textNode(overrides: Partial<Extract<SpatialNode, { type: 'text' }>> = {}): SpatialNode {
  return {
    id: 'n1',
    type: 'text',
    x: 0,
    y: 0,
    width: 200,
    height: 100,
    text: 'hello',
    ...overrides,
  }
}

function edge(overrides: Partial<CanvasEdge> = {}): CanvasEdge {
  return { id: 'e1', fromNode: 'a', toNode: 'b', ...overrides }
}

describe('createSpatialTheme', () => {
  it('resolves a node preset as accent stroke + tint fill from the palette (never a solid accent fill)', () => {
    const theme = createSpatialTheme({ mode: 'light' })
    const { appearance } = theme.resolveNode(textNode({ color: '1' }))
    expect(appearance).toEqual({
      stroke: SPATIAL_LIGHT_PALETTE.presets['1'].stroke,
      fill: SPATIAL_LIGHT_PALETTE.presets['1'].fill,
    })
  })

  it('resolves node presets per MODE — dark mode reads the dark palette accents', () => {
    const theme = createSpatialTheme({ mode: 'dark' })
    const { appearance } = theme.resolveNode(textNode({ color: '3' }))
    expect(appearance).toEqual({
      stroke: SPATIAL_DARK_PALETTE.presets['3'].stroke,
      fill: SPATIAL_DARK_PALETTE.presets['3'].fill,
    })
    expect(SPATIAL_DARK_PALETTE.presets['3'].stroke).not.toBe(
      SPATIAL_LIGHT_PALETTE.presets['3'].stroke,
    )
  })

  it('accepts a wholesale palette override — presets are swappable theme DATA', () => {
    const custom = {
      ...SPATIAL_LIGHT_PALETTE,
      presets: {
        ...SPATIAL_LIGHT_PALETTE.presets,
        '1': { stroke: '#123456', fill: '#abcdef' },
      },
    }
    const theme = createSpatialTheme({ mode: 'light', palette: custom })
    expect(theme.resolveNode(textNode({ color: '1' })).appearance).toEqual({
      stroke: '#123456',
      fill: '#abcdef',
    })
    // Non-preset resolution rides the same override.
    expect(theme.resolveEdge(edge())?.stroke).toBe(custom.edgeStroke)
  })

  it('passes through an already-hex node color unchanged', () => {
    const theme = createSpatialTheme({ mode: 'light' })
    const { appearance } = theme.resolveNode(textNode({ color: '#abcdef' }))
    expect(appearance?.fill).toBe('#abcdef')
  })

  it('falls back to the palette fill/stroke for a node with no authored color', () => {
    const theme = createSpatialTheme({ mode: 'light' })
    const { appearance } = theme.resolveNode(textNode())
    expect(appearance).toEqual({
      fill: SPATIAL_LIGHT_PALETTE.node.text.fill,
      stroke: SPATIAL_LIGHT_PALETTE.node.text.stroke,
    })
  })

  it('falls back to the text style for an unrecognized node type', () => {
    const theme = createSpatialTheme({ mode: 'light' })
    const bogus = { ...textNode(), type: 'bogus' } as unknown as SpatialNode
    const { appearance } = theme.resolveNode(bogus)
    expect(appearance).toEqual({
      fill: SPATIAL_LIGHT_PALETTE.node.text.fill,
      stroke: SPATIAL_LIGHT_PALETTE.node.text.stroke,
    })
  })

  it('uses the palette corner radius for every node', () => {
    const theme = createSpatialTheme({ mode: 'light' })
    const { radius } = theme.resolveNode(textNode())
    expect(radius).toBe(SPATIAL_LIGHT_PALETTE.cornerRadiusPx)
  })

  it('resolves an edge with no authored color to the palette edge stroke', () => {
    const theme = createSpatialTheme({ mode: 'light' })
    expect(theme.resolveEdge(edge())).toEqual({ stroke: SPATIAL_LIGHT_PALETTE.edgeStroke })
  })

  it('resolves an edge preset color to the palette accent stroke', () => {
    const theme = createSpatialTheme({ mode: 'light' })
    expect(theme.resolveEdge(edge({ color: '3' }))).toEqual({
      stroke: SPATIAL_LIGHT_PALETTE.presets['3'].stroke,
    })
  })

  it('resolves a label to the palette label fill and the shared theme font family', () => {
    const theme = createSpatialTheme({ mode: 'light' })
    expect(theme.resolveLabel()).toEqual({
      fill: SPATIAL_LIGHT_PALETTE.labelFill,
      fontFamily: SPATIAL_THEME_FONT_FAMILY,
    })
  })

  it('every preset clears the WCAG floors in BOTH modes (3:1 stroke vs bg, 4.5:1 text vs tint)', () => {
    // These are floors, not pinned values — the palette is swappable data,
    // and any replacement must keep colored nodes readable in both themes.
    const luminance = (hex: string) => {
      const channel = (i: number) => {
        const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
    }
    const contrast = (a: string, b: string) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
      return (hi + 0.05) / (lo + 0.05)
    }
    const cases = [
      { palette: SPATIAL_LIGHT_PALETTE, bg: '#ffffff' },
      { palette: SPATIAL_DARK_PALETTE, bg: '#0a0a0a' },
    ]
    for (const { palette, bg } of cases) {
      for (const key of ['1', '2', '3', '4', '5', '6'] as const) {
        const accent = palette.presets[key]
        expect(contrast(accent.stroke, bg)).toBeGreaterThanOrEqual(3)
        expect(contrast(palette.labelFill, accent.fill)).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('resolves node/edge/label colors from the dark palette in dark mode', () => {
    const theme = createSpatialTheme({ mode: 'dark' })
    expect(theme.resolveNode(textNode()).appearance).toEqual({
      fill: SPATIAL_DARK_PALETTE.node.text.fill,
      stroke: SPATIAL_DARK_PALETTE.node.text.stroke,
    })
    expect(theme.resolveEdge(edge())).toEqual({ stroke: SPATIAL_DARK_PALETTE.edgeStroke })
    expect(theme.resolveLabel().fill).toBe(SPATIAL_DARK_PALETTE.labelFill)
  })
})
