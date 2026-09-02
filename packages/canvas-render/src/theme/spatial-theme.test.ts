import type { CanvasEdge, SpatialNode } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { SPATIAL_THEME_FONT_FAMILY } from './font-family.js'
import { MARKDOWN_THEME_NODE } from './markdown-theme.js'
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

function contrastRatio(a: string, b: string): number {
  const luminance = (hex: string) => {
    const channel = (i: number) => {
      const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
  }
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
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
      halo: SPATIAL_LIGHT_PALETTE.surface,
    })
  })

  it('every preset clears the WCAG floors in BOTH modes (3:1 stroke vs bg, 4.5:1 text vs tint)', () => {
    // These are floors, not pinned values — the palette is swappable data,
    // and any replacement must keep colored nodes readable in both themes.
    const contrast = contrastRatio
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

  it('every syntax role clears the 4.5:1 TEXT floor against the code surface, both modes', () => {
    // A syntax token is text, so it owes WCAG 1.4.3's 4.5:1 — not the 3:1
    // non-text floor the preset strokes above are held to. That difference
    // is why the light roles are a step darker than the light preset
    // strokes: measured on this surface the 600-weight strokes came in at
    // 3.15-3.33.
    //
    // The surface is the theme's chrome neutral at the code panel's opacity
    // over the node ground, composited here rather than guessed — fixing the
    // ground is the whole reason a code block keeps a surface at all.
    //
    // Known limit: a code block inside a COLOUR-PRESET node sits on that
    // node's tint instead, where these roles measure 3.8-4.3. Pinning the
    // floor to the standard ground states what is guaranteed; the tint case
    // is a narrower surface than this test should silently claim to cover.
    const composite = (fg: string, bg: string, alpha: number) => {
      const ch = (hex: string, i: number) => Number.parseInt(hex.slice(i, i + 2), 16)
      const mix = (i: number) => Math.round(ch(fg, i) * alpha + ch(bg, i) * (1 - alpha))
      return `#${[1, 3, 5].map((i) => mix(i).toString(16).padStart(2, '0')).join('')}`
    }
    const cases = [
      { palette: SPATIAL_LIGHT_PALETTE, bg: '#ffffff' },
      { palette: SPATIAL_DARK_PALETTE, bg: '#0a0a0a' },
    ]
    for (const { palette, bg } of cases) {
      const surface = composite(
        MARKDOWN_THEME_NODE.chromeColor,
        bg,
        MARKDOWN_THEME_NODE.panelOpacity,
      )
      for (const role of ['keyword', 'string', 'number', 'comment'] as const) {
        expect(contrastRatio(palette.syntax[role], surface)).toBeGreaterThanOrEqual(4.5)
      }
      // Body text on that same surface, since plain code tokens take it.
      expect(contrastRatio(palette.labelFill, surface)).toBeGreaterThanOrEqual(4.5)
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

  it('gives the comment leader a dashed stroke in the amber ramp, both modes', () => {
    for (const [mode, palette] of [
      ['light', SPATIAL_LIGHT_PALETTE],
      ['dark', SPATIAL_DARK_PALETTE],
    ] as const) {
      const leader = createSpatialTheme({ mode }).resolveComment?.().leader
      expect(leader).toEqual({
        stroke: palette.comment.bubble.stroke,
        strokeWidth: 1,
        strokeDasharray: '4 3',
      })
    }
  })
})
