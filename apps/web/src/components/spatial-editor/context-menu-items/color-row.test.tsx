import { describe, expect, it, vi } from 'vitest'
import { colorRow, presetEntries } from './color-row.js'

describe('colorRow', () => {
  it('offers default plus every preset, selecting the current value', () => {
    const apply = vi.fn()
    const row = colorRow('light', '3', apply)
    expect(row.label).toBe('Color')
    expect(row.options.map((o) => o.label)).toEqual(['default', ...presetEntries.map((p) => p.key)])
    const yellow = row.options.find((o) => o.label === '3')
    expect(yellow?.selected).toBe(true)
    expect(row.options.find((o) => o.label === 'default')?.selected).toBe(false)
  })

  it('applies undefined for the default option and the preset key for a swatch', () => {
    const apply = vi.fn()
    const row = colorRow('light', undefined, apply)
    row.options.find((o) => o.label === 'default')?.onSelect()
    expect(apply).toHaveBeenCalledWith(undefined)
    row.options.find((o) => o.label === '2')?.onSelect()
    expect(apply).toHaveBeenCalledWith('2')
  })

  it('the custom color entry reflects a hex value and applies a picked hex', () => {
    const apply = vi.fn()
    const row = colorRow('light', '#112233', apply)
    expect(row.customColor?.selected).toBe(true)
    expect(row.customColor?.value).toBe('#112233')
    row.customColor?.onPick('#445566')
    expect(apply).toHaveBeenCalledWith('#445566')
  })
})
