import { describe, it, expect } from 'vitest'
import {
  contrastRatio,
  DEFAULT_PALETTE_FALLBACK,
  normalizeColor,
  relativeLuminance,
  resolvePaletteColor,
  SEMANTIC_PALETTE,
} from './color-palette.js'

describe('relativeLuminance hex-digit handling', () => {
  it('parses 3- and 6-digit hex to the same luminance', () => {
    expect(relativeLuminance('#fff')).toBeCloseTo(relativeLuminance('#ffffff')!, 10)
    expect(relativeLuminance('#000')).toBe(relativeLuminance('#000000'))
  })

  it('drops the alpha channel of 4- and 8-digit hex (treated as opaque)', () => {
    // #2f9e44 with any alpha suffix must equal the opaque luminance.
    expect(relativeLuminance('#2f9e4480')).toBeCloseTo(relativeLuminance('#2f9e44')!, 10)
    // 4-digit #rgba: rgb nibbles are 2/9/4 -> #229944 doubled.
    expect(relativeLuminance('#2948')).toBeCloseTo(relativeLuminance('#229944')!, 10)
  })

  it('returns null for non-hex input', () => {
    expect(relativeLuminance('rebeccapurple')).toBeNull()
    expect(relativeLuminance('#12345')).toBeNull()
  })

  it('lets contrastRatio work against an 8-digit fill instead of returning null', () => {
    expect(contrastRatio('#1e1e2e', '#2f9e4480')).toBeCloseTo(
      contrastRatio('#1e1e2e', '#2f9e44')!,
      10,
    )
  })
})

describe('normalizeColor', () => {
  it('case 116', () => {
    expect(normalizeColor(undefined)).toBeUndefined()
  })

  it('case 117', () => {
    expect(normalizeColor('primary')).toBe(SEMANTIC_PALETTE.primary)
    expect(normalizeColor('success')).toBe(SEMANTIC_PALETTE.success)
    expect(normalizeColor('danger')).toBe(SEMANTIC_PALETTE.danger)
    expect(normalizeColor('warning')).toBe(SEMANTIC_PALETTE.warning)
    expect(normalizeColor('neutral')).toBe(SEMANTIC_PALETTE.neutral)
    expect(normalizeColor('info')).toBe(SEMANTIC_PALETTE.info)
  })

  it('case 118', () => {
    expect(normalizeColor('PRIMARY')).toBe(SEMANTIC_PALETTE.primary)
    expect(normalizeColor('Success')).toBe(SEMANTIC_PALETTE.success)
  })

  it('case 119', () => {
    expect(normalizeColor('#1971c2')).toBe('#1971c2')
    expect(normalizeColor('#ABC')).toBe('#ABC')
    expect(normalizeColor('#ff00aa')).toBe('#ff00aa')
  })

  it('case 120', () => {
    expect(normalizeColor('red')).toBe('red')
    expect(normalizeColor('steelblue')).toBe('steelblue')
  })

  it('case 121', () => {
    for (const [key, hex] of Object.entries(SEMANTIC_PALETTE)) {
      expect(hex, `${key} must use #rrggbb format`).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })

  it('case 122', () => {
    const keys = Object.keys(SEMANTIC_PALETTE).sort()
    expect(keys).toEqual(['danger', 'info', 'neutral', 'primary', 'success', 'warning'])
  })
})

describe('resolvePaletteColor', () => {
  it('case 123', () => {
    const result = resolvePaletteColor('#1971c2', { 'accent.target': '#ff0000' })
    expect(result).toEqual({ color: '#1971c2' })
  })

  it('case 124', () => {
    const result = resolvePaletteColor('accent.target', { 'accent.target': '#1971c2' })
    expect(result).toEqual({ color: '#1971c2' })
  })

  it('case 125', () => {
    const result = resolvePaletteColor('warning', {})
    expect(result).toEqual({ color: SEMANTIC_PALETTE.warning })
  })

  it('case 126', () => {
    const result = resolvePaletteColor('plan.ghost', {})
    expect(result).toEqual({
      color: DEFAULT_PALETTE_FALLBACK,
      warningKey: 'plan.ghost',
    })
  })
})
