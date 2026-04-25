import { describe, it, expect } from 'vitest'
import {
  DEFAULT_PALETTE_FALLBACK,
  normalizeColor,
  resolvePaletteColor,
  SEMANTIC_PALETTE,
} from './color-palette.js'

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
