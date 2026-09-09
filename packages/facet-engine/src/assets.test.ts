import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createFacetRegistry, defineFacet, definePlugin } from './registry.js'
import { SAMPLE_THEME_TOKENS } from './theme-tokens.js'

const themedPlugin = definePlugin({
  id: 'paint',
  displayName: 'Paint',
  facets: [
    defineFacet({
      name: 'theme',
      displayName: 'Theme',
      version: 'v0',
      targets: ['canvas'],
      schema: z.object({ theme: z.string().min(1) }),
      assetRefs: { theme: 'themes' },
    }),
  ],
  assets: {
    themes: { chalk: SAMPLE_THEME_TOKENS },
    icons: { spark: { geometry: [{ tag: 'circle', cx: 12, cy: 12, r: 4 }] } },
  },
})

const otherPlugin = definePlugin({
  id: 'infra',
  displayName: 'Infra',
  facets: [],
  assets: { themes: { chalk: SAMPLE_THEME_TOKENS } },
})

describe('plugin assets', () => {
  it('namespaces every asset to <plugin>.<name> and answers it by kind', () => {
    const registry = createFacetRegistry([themedPlugin, otherPlugin])
    expect(registry.themeAsset('paint.chalk')).toEqual(SAMPLE_THEME_TOKENS)
    expect(registry.themeAsset('infra.chalk')).toEqual(SAMPLE_THEME_TOKENS)
    expect(registry.iconAsset('paint.spark')?.geometry).toHaveLength(1)
    expect(registry.assetIds('themes')).toEqual(['paint.chalk', 'infra.chalk'])
    expect(registry.assetIds('icons')).toEqual(['paint.spark'])
  })

  it('answers undefined for an unknown id, a bare name, and a wrong kind', () => {
    const registry = createFacetRegistry([themedPlugin])
    expect(registry.themeAsset('paint.missing')).toBeUndefined()
    expect(registry.themeAsset('chalk')).toBeUndefined()
    expect(registry.themeAsset('paint.spark')).toBeUndefined()
    expect(registry.iconAsset('paint.chalk')).toBeUndefined()
  })

  it('a plugin with no assets registers exactly as before', () => {
    const plain = definePlugin({ id: 'plain', displayName: 'Plain', facets: [] })
    const registry = createFacetRegistry([plain])
    expect(registry.assetIds('themes')).toEqual([])
    expect(registry.themeAsset('plain.anything')).toBeUndefined()
  })

  it('rejects an asset name that is not a key segment at definition time', () => {
    expect(() =>
      definePlugin({
        id: 'bad',
        displayName: 'Bad',
        facets: [],
        assets: { themes: { 'Not Ok': SAMPLE_THEME_TOKENS } },
      }),
    ).toThrow(/asset name/)
  })

  it('hands out the PARSED tokens, so a theme that omits defaults still has an empty one', () => {
    // Every reader of a theme dereferences `defaults`; a plugin that leaves
    // it out (a hand-written asset, one parsed from JSON) must not hand the
    // renderer an object the schema would have filled in.
    const { defaults: _omitted, ...bare } = SAMPLE_THEME_TOKENS
    const sparse = definePlugin({
      id: 'sparse',
      displayName: 'Sparse',
      facets: [],
      assets: { themes: { bare } },
    })
    const registry = createFacetRegistry([sparse])
    expect(registry.themeAsset('sparse.bare')?.defaults).toEqual({})
  })

  it('rejects a theme asset that does not satisfy the token contract at definition time', () => {
    expect(() =>
      definePlugin({
        id: 'bad',
        displayName: 'Bad',
        facets: [],
        assets: { themes: { broken: { ink: 'sketch' } as never } },
      }),
    ).toThrow(/theme asset "broken"/)
  })
})

describe('assetRefs on a facet definition', () => {
  it('rejects a ref naming a field the schema does not declare, like an editor spec does', () => {
    expect(() =>
      defineFacet({
        name: 'theme',
        displayName: 'Theme',
        version: 'v0',
        targets: ['canvas'],
        schema: z.object({ theme: z.string() }),
        assetRefs: { look: 'themes' },
      }),
    ).toThrow(/assetRefs names field "look"/)
  })

  it('validateFacetWrite accepts a registered asset id, from any plugin', () => {
    const registry = createFacetRegistry([themedPlugin, otherPlugin])
    expect(registry.validateFacetWrite('paint.theme/v0', { theme: 'paint.chalk' })).toEqual({
      ok: true,
      value: { theme: 'paint.chalk' },
    })
    expect(registry.validateFacetWrite('paint.theme/v0', { theme: 'infra.chalk' }).ok).toBe(true)
  })

  it('validateFacetWrite rejects an unregistered asset id and names what is registered', () => {
    const registry = createFacetRegistry([themedPlugin])
    const result = registry.validateFacetWrite('paint.theme/v0', { theme: 'paint.neon' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toMatch(/"paint.neon"/)
    expect(result.message).toMatch(/paint\.chalk/)
  })

  it('the schema message comes first when the payload is malformed', () => {
    const registry = createFacetRegistry([themedPlugin])
    const result = registry.validateFacetWrite('paint.theme/v0', { theme: '' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toMatch(/invalid/)
  })

  it('resolveFacetPayload does NOT check refs — a stored id another deployment registered is data', () => {
    const registry = createFacetRegistry([themedPlugin])
    expect(registry.resolveFacetPayload('paint.theme/v0', { theme: 'elsewhere.look' })).toEqual({
      kind: 'resolved',
      value: { theme: 'elsewhere.look' },
    })
  })
})
