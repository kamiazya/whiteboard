import { describe, expect, it } from 'vitest'
import { SAMPLE_THEME_TOKENS, themeTokensSchema } from './theme-tokens.js'

describe('themeTokensSchema', () => {
  it('accepts a complete token bundle with both palettes', () => {
    const parsed = themeTokensSchema.parse(SAMPLE_THEME_TOKENS)
    expect(parsed.ink).toBe('sketch')
    expect(parsed.palette.dark.surface).toBe('#0a0a0a')
    // `defaults` is always present after parsing, so a consumer never
    // branches on its absence.
    expect(parsed.defaults).toEqual({ edgeRouting: 'curved' })
  })

  it('rejects a palette colour that is not six-digit hex — resvg parses no oklch', () => {
    const bad = {
      ...SAMPLE_THEME_TOKENS,
      palette: {
        ...SAMPLE_THEME_TOKENS.palette,
        light: { ...SAMPLE_THEME_TOKENS.palette.light, surface: 'oklch(0.98 0 0)' },
      },
    }
    expect(themeTokensSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects a bundle missing its dark palette — every theme carries both modes', () => {
    const { dark: _dark, ...lightOnly } = SAMPLE_THEME_TOKENS.palette
    expect(
      themeTokensSchema.safeParse({ ...SAMPLE_THEME_TOKENS, palette: lightOnly }).success,
    ).toBe(false)
  })

  it('allows a node fill of "none" (an outlined node) but no other keyword', () => {
    const none = {
      ...SAMPLE_THEME_TOKENS,
      palette: {
        ...SAMPLE_THEME_TOKENS.palette,
        dark: {
          ...SAMPLE_THEME_TOKENS.palette.dark,
          node: {
            ...SAMPLE_THEME_TOKENS.palette.dark.node,
            text: { fill: 'none', stroke: '#9ba3af' },
          },
        },
      },
    }
    expect(themeTokensSchema.safeParse(none).success).toBe(true)
    const transparent = {
      ...none,
      palette: {
        ...none.palette,
        dark: {
          ...none.palette.dark,
          node: { ...none.palette.dark.node, text: { fill: 'transparent', stroke: '#9ba3af' } },
        },
      },
    }
    expect(themeTokensSchema.safeParse(transparent).success).toBe(false)
  })

  it('rejects a default node shape that is not a namespaced id', () => {
    const bare = { ...SAMPLE_THEME_TOKENS, defaults: { nodeShape: 'diamond' } }
    expect(themeTokensSchema.safeParse(bare).success).toBe(false)
    const namespaced = { ...SAMPLE_THEME_TOKENS, defaults: { nodeShape: 'visual.diamond' } }
    expect(themeTokensSchema.safeParse(namespaced).success).toBe(true)
  })

  it('accepts an optional line weight and rejects a non-positive one', () => {
    const base = themeTokensSchema.parse(SAMPLE_THEME_TOKENS)
    expect(themeTokensSchema.parse({ ...base, strokeWidthPx: 1.4 }).strokeWidthPx).toBe(1.4)
    expect(themeTokensSchema.safeParse({ ...base, strokeWidthPx: 0 }).success).toBe(false)
  })

  it('rejects a glow without a positive radius', () => {
    expect(
      themeTokensSchema.safeParse({ ...SAMPLE_THEME_TOKENS, glow: { radiusPx: 0 } }).success,
    ).toBe(false)
  })
})
