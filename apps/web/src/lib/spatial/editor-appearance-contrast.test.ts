// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { contrast } from '../../test-utils/contrast.js'
import { EDITOR_DARK_PALETTE, EDITOR_LIGHT_PALETTE } from './editor-appearance.js'

// Mirrors apps/web/src/index.css's `--background` token per theme (light:
// oklch(1 0 0), dark: oklch(0.145 0 0)) — declared here, not eyeballed, so
// this test is the tripwire if the design tokens ever drift.
const SURFACE = { light: '#FFFFFF', dark: '#0A0A0A' } as const

describe('editor theme palette contrast (WCAG)', () => {
  it('chrome stroke clears the WCAG 1.4.11 non-text UI floor (3.0:1) in both themes', () => {
    expect(contrast(EDITOR_LIGHT_PALETTE.chromeStroke, SURFACE.light)).toBeGreaterThanOrEqual(3.0)
    expect(contrast(EDITOR_DARK_PALETTE.chromeStroke, SURFACE.dark)).toBeGreaterThanOrEqual(3.0)
  })

  it('text/label fill clears the WCAG 1.4.3 text floor (4.5:1) in both themes', () => {
    expect(contrast(EDITOR_LIGHT_PALETTE.textFill, SURFACE.light)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(EDITOR_DARK_PALETTE.textFill, SURFACE.dark)).toBeGreaterThanOrEqual(4.5)
  })

  it('non-vacuity: the retired hardcoded #333333 fails against the dark surface', () => {
    expect(contrast('#333333', SURFACE.dark)).toBeLessThan(3.0)
  })
})
