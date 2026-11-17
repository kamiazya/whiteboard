import { type PaletteTokens, themeTokensSchema } from '@kamiazya/whiteboard-facet-engine'
import { SAMPLE_THEME_TOKENS } from '@kamiazya/whiteboard-facet-engine/testing'
import { edgeRoutingStyleSchema } from '@kamiazya/whiteboard-model'
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  SPATIAL_DARK_PALETTE,
  SPATIAL_LIGHT_PALETTE,
  type SpatialPalette,
} from './spatial-palette.js'
import { createSpatialTheme } from './spatial-theme.js'
import { paletteFromTokens } from './theme-asset.js'

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

  it("carries a theme's markdown chrome, and none where the bundled palettes declare none", () => {
    const tokens = themeTokensSchema.shape.palette.shape.light.parse({
      ...SPATIAL_LIGHT_PALETTE,
      markdownChrome: '#8a8378',
    })
    expect(paletteFromTokens(tokens).markdownChrome).toBe('#8a8378')
    // Absent everywhere the bundled palettes are: same key set.
    expect(paletteFromTokens(SAMPLE_THEME_TOKENS.palette.light).markdownChrome).toBeUndefined()
  })

  it('the token contract spells edge routing exactly as the model does', () => {
    expect(themeTokensSchema.shape.defaults.unwrap().shape.edgeRouting.unwrap().options).toEqual(
      edgeRoutingStyleSchema.options,
    )
  })
})

describe('createSpatialTheme', () => {
  it('stamps its mode on the resolver so a layout can pick the matching theme palette', () => {
    expect(createSpatialTheme({ mode: 'light' }).mode).toBe('light')
    expect(createSpatialTheme({ mode: 'dark' }).mode).toBe('dark')
    expect(createSpatialTheme({ mode: 'dark', palette: SPATIAL_LIGHT_PALETTE }).mode).toBe('dark')
  })
})
