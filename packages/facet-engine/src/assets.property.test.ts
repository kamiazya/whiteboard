import { test } from '@fast-check/vitest'
import * as fc from 'fast-check'
import { describe, expect } from 'vitest'
import { z } from 'zod'
import { createFacetRegistry, defineFacet, definePlugin } from './registry.js'
import { SAMPLE_THEME_TOKENS } from './theme-tokens.js'

const segment = fc
  .stringMatching(/^[a-z][a-z0-9-]{0,7}$/)
  .filter((s) => /^[a-z][a-z0-9-]*$/.test(s))

/** A plugin set with distinct ids, each carrying a distinct set of theme asset names. */
const pluginSet = fc
  .uniqueArray(
    fc.record({
      id: segment,
      themes: fc.uniqueArray(segment, { minLength: 0, maxLength: 4 }),
    }),
    { minLength: 1, maxLength: 4, selector: (p) => p.id },
  )
  .map((plugins) =>
    plugins.map((p) =>
      definePlugin({
        id: p.id,
        displayName: p.id,
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
        assets: { themes: Object.fromEntries(p.themes.map((t) => [t, SAMPLE_THEME_TOKENS])) },
      }),
    ),
  )

describe('asset registry', () => {
  test.prop([pluginSet])(
    'every listed id resolves, and every plugin/name pair is listed',
    (plugins) => {
      const registry = createFacetRegistry(plugins)
      const listed = registry.assetIds('themes')
      for (const id of listed) expect(registry.themeAsset(id)).toBeDefined()
      const expected = plugins.flatMap((p) =>
        Object.keys(p.assets?.themes ?? {}).map((n) => `${p.id}.${n}`),
      )
      expect([...listed].sort()).toEqual([...expected].sort())
      // Injective: no two (plugin, name) pairs collapse onto one id.
      expect(new Set(listed).size).toBe(expected.length)
    },
  )

  test.prop([pluginSet, segment, segment])(
    'validateFacetWrite accepts an id iff it is listed',
    (plugins, ns, name) => {
      const registry = createFacetRegistry(plugins)
      const id = `${ns}.${name}`
      const key = `${plugins[0]?.id}.theme/v0`
      const result = registry.validateFacetWrite(key, { theme: id })
      expect(result.ok).toBe(registry.assetIds('themes').includes(id))
    },
  )
})
