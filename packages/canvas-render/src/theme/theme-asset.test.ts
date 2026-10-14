import { type PaletteTokens, themeTokensSchema } from '@kamiazya/whiteboard-facet-engine'
import { SAMPLE_THEME_TOKENS } from '@kamiazya/whiteboard-facet-engine/testing'
import { edgeRoutingStyleSchema } from '@kamiazya/whiteboard-model'
import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { SPATIAL_THEME_FONT_FAMILY } from './font-family.js'
import { MARKDOWN_THEME_NODE } from './markdown-theme.js'
import {
  SPATIAL_DARK_PALETTE,
  SPATIAL_LIGHT_PALETTE,
  type SpatialPalette,
} from './spatial-palette.js'
import { createSpatialTheme } from './spatial-theme.js'
import { createThemedAppearance, markdownTheme, paletteFromTokens } from './theme-asset.js'

// The same keys on both sides, at every level, OPTIONAL ones included.
// `paletteFromTokens` builds its literal field by field, which ties a
// REQUIRED field and nothing else: a key optional on either side is absent
// from the literal without complaint, and a parse strips an unknown one, so
// neither the compiler nor a round-trip would notice it go missing.
type KeySetsEqual<A, B> = [keyof A] extends [keyof B]
  ? [keyof B] extends [keyof A]
    ? true
    : false
  : false
type DeepKeySetsEqual<A, B> =
  KeySetsEqual<A, B> extends false
    ? false
    : false extends {
          [K in keyof A & keyof B]-?: NonNullable<A[K]> extends object
            ? DeepKeySetsEqual<NonNullable<A[K]>, NonNullable<B[K]>>
            : true
        }[keyof A & keyof B]
      ? false
      : true

describe('paletteFromTokens', () => {
  it('the token contract and the renderer palette name the same keys at every level', () => {
    expectTypeOf<DeepKeySetsEqual<PaletteTokens, SpatialPalette>>().toEqualTypeOf<true>()
    expectTypeOf<DeepKeySetsEqual<SpatialPalette, PaletteTokens>>().toEqualTypeOf<true>()
    // The helper itself refuses a one-sided key, nested and optional alike.
    expectTypeOf<
      DeepKeySetsEqual<{ a: { b: string } }, { a: { b: string; c?: string } }>
    >().toEqualTypeOf<false>()
    expectTypeOf<
      DeepKeySetsEqual<{ a: string; c?: string }, { a: string }>
    >().toEqualTypeOf<false>()
  })

  it('maps every field the renderer palette has — a token bundle can say everything the bundled palette says', () => {
    const palette = paletteFromTokens(SAMPLE_THEME_TOKENS.palette.light)
    expect(Object.keys(palette).sort()).toEqual(Object.keys(SPATIAL_LIGHT_PALETTE).sort())
    expect(palette.presets['5']).toEqual(SAMPLE_THEME_TOKENS.palette.light.presets['5'])
    expect(palette.comment).toEqual(SAMPLE_THEME_TOKENS.palette.light.comment)
  })

  it.each([
    ['light', SPATIAL_LIGHT_PALETTE],
    ['dark', SPATIAL_DARK_PALETTE],
  ] as const)('the bundled %s palette round-trips through the token contract', (_mode, bundled) => {
    // A value the contract cannot carry is stripped by the parse and so
    // missing here — a bundled palette saying something no theme can say.
    const tokens = themeTokensSchema.shape.palette.shape.light.parse(bundled)
    expect(paletteFromTokens(tokens)).toEqual(bundled)
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
