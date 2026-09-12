// @vitest-environment node
import { resolveCanvasPalette, SPATIAL_LIGHT_PALETTE } from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { describe, expect, it, vi } from 'vitest'
import { colorRow, presetEntries } from './color-row.js'

describe('colorRow', () => {
  it('offers default plus every preset, selecting the current value', () => {
    const apply = vi.fn()
    const row = colorRow(SPATIAL_LIGHT_PALETTE, '3', apply)
    expect(row.label).toBe('Color')
    expect(row.options.map((o) => o.label)).toEqual(['default', ...presetEntries.map((p) => p.key)])
    const yellow = row.options.find((o) => o.label === '3')
    expect(yellow?.selected).toBe(true)
    expect(row.options.find((o) => o.label === 'default')?.selected).toBe(false)
  })

  it('applies undefined for the default option and the preset key for a swatch', () => {
    const apply = vi.fn()
    const row = colorRow(SPATIAL_LIGHT_PALETTE, undefined, apply)
    row.options.find((o) => o.label === 'default')?.onSelect()
    expect(apply).toHaveBeenCalledWith(undefined)
    row.options.find((o) => o.label === '2')?.onSelect()
    expect(apply).toHaveBeenCalledWith('2')
  })

  it('the custom color entry reflects a hex value and applies a picked hex', () => {
    const apply = vi.fn()
    const row = colorRow(SPATIAL_LIGHT_PALETTE, '#112233', apply)
    expect(row.customColor?.selected).toBe(true)
    expect(row.customColor?.value).toBe('#112233')
    row.customColor?.onPick('#445566')
    expect(apply).toHaveBeenCalledWith('#445566')
  })

  it("the swatches preview the palette the canvas is drawn in, so a themed board's picker matches its paint", () => {
    const neon: SpatialCanvas = {
      nodes: [],
      edges: [],
      facets: { 'visual.theme/v0': { theme: 'visual.neon' } },
    }
    const palette = resolveCanvasPalette(neon, 'dark')
    const row = colorRow(palette, undefined, vi.fn())
    const swatch = row.options.find((o) => o.label === '3')?.icon as {
      props: { style: { backgroundColor: string } }
    }
    expect(swatch.props.style.backgroundColor).toBe(palette.presets['3'].stroke)
    expect(swatch.props.style.backgroundColor).not.toBe(SPATIAL_LIGHT_PALETTE.presets['3'].stroke)
  })
})
