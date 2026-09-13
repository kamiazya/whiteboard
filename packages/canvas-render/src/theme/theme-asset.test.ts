import { SAMPLE_THEME_TOKENS, themeTokensSchema } from '@kamiazya/whiteboard-facet-engine'
import { edgeRoutingStyleSchema } from '@kamiazya/whiteboard-model'
import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { SPATIAL_THEME_FONT_FAMILY } from './font-family.js'
import { MARKDOWN_THEME_NODE } from './markdown-theme.js'
import { SPATIAL_LIGHT_PALETTE } from './spatial-palette.js'
import { createSpatialTheme } from './spatial-theme.js'
import { createThemedAppearance, markdownTheme, paletteFromTokens } from './theme-asset.js'

describe('paletteFromTokens', () => {
  it('maps every field the renderer palette has — a token bundle can say everything the bundled palette says', () => {
    const palette = paletteFromTokens(SAMPLE_THEME_TOKENS.palette.light)
    expect(Object.keys(palette).sort()).toEqual(Object.keys(SPATIAL_LIGHT_PALETTE).sort())
    expect(palette.presets['5']).toEqual(SAMPLE_THEME_TOKENS.palette.light.presets['5'])
    expect(palette.comment).toEqual(SAMPLE_THEME_TOKENS.palette.light.comment)
  })

  it('the bundled light palette round-trips through the token contract', () => {
    // The two shapes are meant to be one: if a field is added to the
    // renderer's palette and not the contract (or the reverse), this fails.
    const tokens = themeTokensSchema.shape.palette.shape.light.parse(SPATIAL_LIGHT_PALETTE)
    expect(paletteFromTokens(tokens)).toEqual(SPATIAL_LIGHT_PALETTE)
  })

  it("carries a theme's markdown chrome, and leaves the bundled body neutral alone without one", () => {
    const tokens = themeTokensSchema.shape.palette.shape.light.parse({
      ...SPATIAL_LIGHT_PALETTE,
      markdownChrome: '#8a8378',
    })
    expect(paletteFromTokens(tokens).markdownChrome).toBe('#8a8378')
    expect(
      markdownTheme({ ...SAMPLE_THEME_TOKENS, palette: { light: tokens, dark: tokens } }, 'light')
        .chromeColor,
    ).toBe('#8a8378')
    // Absent everywhere the bundled palettes are: same key set, same theme.
    expect(paletteFromTokens(SAMPLE_THEME_TOKENS.palette.light).markdownChrome).toBeUndefined()
    expect(markdownTheme(SAMPLE_THEME_TOKENS, 'light')).toBe(MARKDOWN_THEME_NODE)
    expect(markdownTheme(undefined, undefined)).toBe(MARKDOWN_THEME_NODE)
  })

  it('the token contract spells edge routing exactly as the model does', () => {
    expect(themeTokensSchema.shape.defaults.unwrap().shape.edgeRouting.unwrap().options).toEqual(
      edgeRoutingStyleSchema.options,
    )
  })
})

describe('createThemedAppearance', () => {
  it("is memoized per (tokens, mode, family): the editor's useMemo deps stay stable", () => {
    const a = createThemedAppearance({
      tokens: SAMPLE_THEME_TOKENS,
      mode: 'light',
      fontFamily: 'Roboto',
    })
    const b = createThemedAppearance({
      tokens: SAMPLE_THEME_TOKENS,
      mode: 'light',
      fontFamily: 'Roboto',
    })
    const dark = createThemedAppearance({
      tokens: SAMPLE_THEME_TOKENS,
      mode: 'dark',
      fontFamily: 'Roboto',
    })
    expect(a).toBe(b)
    expect(dark).not.toBe(a)
    expect(a.mode).toBe('light')
    expect(dark.mode).toBe('dark')
  })

  it('declares the family it is given on every label run', () => {
    const themed = createThemedAppearance({
      tokens: SAMPLE_THEME_TOKENS,
      mode: 'light',
      fontFamily: 'Patrick Hand',
    })
    expect(themed.resolveLabel().fontFamily).toBe('Patrick Hand')
    const fallback = createThemedAppearance({
      tokens: SAMPLE_THEME_TOKENS,
      mode: 'light',
      fontFamily: SPATIAL_THEME_FONT_FAMILY,
    })
    expect(fallback.resolveLabel().fontFamily).toBe(SPATIAL_THEME_FONT_FAMILY)
  })

  it('a group frame carries the theme dash and width; other kinds do not', () => {
    const themed = createThemedAppearance({
      tokens: {
        ...SAMPLE_THEME_TOKENS,
        defaults: { groupFrame: { strokeDasharray: '6 4', strokeWidth: 2 } },
      },
      mode: 'light',
      fontFamily: 'Roboto',
    })
    const group = themed.resolveNode(groupNode({ id: 'g', x: 0, y: 0, width: 10, height: 10 }))
    expect(group.appearance?.strokeDasharray).toBe('6 4')
    expect(group.appearance?.strokeWidth).toBe(2)
    const text = themed.resolveNode(
      textNode({ id: 't', x: 0, y: 0, width: 10, height: 10, text: '' }),
    )
    expect(text.appearance?.strokeDasharray).toBeUndefined()
  })
})

describe('stroke width tokens', () => {
  it('a theme line weight reaches node chrome and edges, never labels; a group frame keeps its own', () => {
    const themed = createThemedAppearance({
      tokens: {
        ...SAMPLE_THEME_TOKENS,
        strokeWidthPx: 1.4,
        defaults: { groupFrame: { strokeWidth: 2 } },
      },
      mode: 'light',
      fontFamily: 'Roboto',
    })
    const text = themed.resolveNode(
      textNode({ id: 't', x: 0, y: 0, width: 10, height: 10, text: '' }),
    )
    expect(text.appearance?.strokeWidth).toBe(1.4)
    const group = themed.resolveNode(groupNode({ id: 'g', x: 0, y: 0, width: 10, height: 10 }))
    expect(group.appearance?.strokeWidth).toBe(2)
    expect(
      themed.resolveEdge({
        id: 'e',
        from: { node: 'a' },
        to: { node: 'b' },
      })?.strokeWidth,
    ).toBe(1.4)
    expect(themed.resolveLabel().strokeWidth).toBeUndefined()
    const bare = createThemedAppearance({
      tokens: SAMPLE_THEME_TOKENS,
      mode: 'light',
      fontFamily: 'Roboto',
    })
    expect(
      bare.resolveNode(textNode({ id: 't', x: 0, y: 0, width: 10, height: 10, text: '' }))
        .appearance?.strokeWidth,
    ).toBeUndefined()
  })
})

describe('createSpatialTheme', () => {
  it('stamps its mode on the resolver so a layout can pick the matching theme palette', () => {
    expect(createSpatialTheme({ mode: 'light' }).mode).toBe('light')
    expect(createSpatialTheme({ mode: 'dark' }).mode).toBe('dark')
    expect(createSpatialTheme({ mode: 'dark', palette: SPATIAL_LIGHT_PALETTE }).mode).toBe('dark')
  })
})

describe('glow tokens', () => {
  it('a theme with glow puts a halo on node chrome and edges, never on a label or a group frame', () => {
    const themed = createThemedAppearance({
      tokens: { ...SAMPLE_THEME_TOKENS, glow: { radiusPx: 6 }, defaults: {} },
      mode: 'dark',
      fontFamily: 'Roboto',
    })
    const node = themed.resolveNode(
      textNode({ id: 'n', x: 0, y: 0, width: 10, height: 10, text: '' }),
    )
    expect(node.appearance?.glow).toEqual({ radiusPx: 6 })
    expect(
      themed.resolveEdge({
        id: 'e',
        from: { node: 'a' },
        to: { node: 'b' },
      })?.glow,
    ).toEqual({
      radiusPx: 6,
    })
    // A 12px glyph blurred at three deviations thickens into a smudge, and
    // the label already sits on its halo pill; a container's frame is the
    // largest and least informative thing on the board to bloom.
    expect(themed.resolveLabel().glow).toBeUndefined()
    const group = themed.resolveNode(groupNode({ id: 'g', x: 0, y: 0, width: 10, height: 10 }))
    expect(group.appearance?.glow).toBeUndefined()
  })

  it('a theme without glow leaves every appearance halo-free', () => {
    const themed = createThemedAppearance({
      tokens: SAMPLE_THEME_TOKENS,
      mode: 'dark',
      fontFamily: 'Roboto',
    })
    expect(
      themed.resolveNode(textNode({ id: 'n', x: 0, y: 0, width: 10, height: 10, text: '' }))
        .appearance?.glow,
    ).toBeUndefined()
    expect(
      themed.resolveEdge({
        id: 'e',
        from: { node: 'a' },
        to: { node: 'b' },
      })?.glow,
    ).toBeUndefined()
  })
})
