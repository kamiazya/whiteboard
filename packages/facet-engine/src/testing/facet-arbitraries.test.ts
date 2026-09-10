// The registry-level generator: every facet the registry holds for a target
// is produced, nothing produced is refused by `validateFacetWrite`, and an
// asset reference draws a REGISTERED id rather than a random string.

import { acceptedOrThrow, arbitraryForSchema } from '@kamiazya/whiteboard-model/test-utils'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createFacetRegistry, defineFacet, definePlugin } from '../registry.js'
import { facetEntries, facetsArbitrary } from './facet-arbitraries.js'

const shape = defineFacet({
  name: 'shape',
  displayName: 'Shape',
  version: 'v0',
  targets: ['node'],
  schema: z.object({ kind: z.enum(['ellipse', 'diamond']) }),
})
const badge = defineFacet({
  name: 'badge',
  displayName: 'Badge',
  version: 'v0',
  targets: ['node'],
  // A refinement the walk cannot see, honoured by the registry's own check.
  schema: z.object({ char: z.string().refine((s) => [...s].length === 1) }),
})
const symbol = defineFacet({
  name: 'symbol',
  displayName: 'Symbol',
  version: 'v0',
  targets: ['canvas'],
  schema: z.object({ icon: z.string() }),
  assetRefs: { icon: 'icons' },
})
const registry = createFacetRegistry([
  definePlugin({
    id: 'demo',
    displayName: 'Demo',
    facets: [shape, badge, symbol],
    assets: { icons: { star: { geometry: [{ tag: 'path', d: 'M0 0h1' }] } } },
  }),
])

describe('facetEntries', () => {
  it('answers per target, with the storage key', () => {
    expect(facetEntries(registry, 'node').map((e) => e.key)).toEqual([
      'demo.shape/v0',
      'demo.badge/v0',
    ])
    expect(facetEntries(registry, 'canvas').map((e) => e.key)).toEqual(['demo.symbol/v0'])
  })
})

describe('facetsArbitrary', () => {
  it('produces every facet for the target, each independently absent, and only accepted payloads', () => {
    const seen = new Set<string>()
    const kinds = new Set<string>()
    let empty = 0
    for (const facets of fc.sample(facetsArbitrary(registry, 'node'), 300)) {
      if (Object.keys(facets).length === 0) empty++
      for (const [key, payload] of Object.entries(facets)) {
        seen.add(key)
        expect(registry.validateFacetWrite(key, payload).ok, key).toBe(true)
        if (key === 'demo.shape/v0') kinds.add((payload as { kind: string }).kind)
      }
    }
    expect([...seen].sort()).toEqual(['demo.badge/v0', 'demo.shape/v0'])
    expect(kinds).toEqual(new Set(['ellipse', 'diamond']))
    expect(empty).toBeGreaterThan(0)
  })

  it('draws a registered asset id for an assetRefs field', () => {
    for (const facets of fc.sample(facetsArbitrary(registry, 'canvas'), 50)) {
      const payload = facets['demo.symbol/v0'] as { icon: string } | undefined
      if (payload !== undefined) expect(payload.icon).toBe('demo.star')
    }
  })

  it('refuses a registry whose asset kind has nothing registered, naming the field', () => {
    const bare = createFacetRegistry([
      definePlugin({ id: 'demo', displayName: 'Demo', facets: [symbol] }),
    ])
    expect(() => facetsArbitrary(bare, 'canvas')).toThrow(/"icons".*demo\.symbol\/v0\.icon/)
  })

  it('throws naming the facet instead of looping when the registry accepts nothing drawn', () => {
    const closed = defineFacet({
      name: 'closed',
      displayName: 'Closed',
      version: 'v0',
      targets: ['node'],
      schema: z.object({ id: z.string() }),
      assetRefs: { id: 'icons' },
    })
    const withStar = createFacetRegistry([
      definePlugin({
        id: 'demo',
        displayName: 'Demo',
        facets: [closed],
        assets: { icons: { star: { geometry: [{ tag: 'path', d: 'M0 0h1' }] } } },
      }),
    ])
    // The override is what makes the draw pass; without it every string is
    // refused by the registry, and that has to surface as an error, not a hang.
    expect(() =>
      acceptedOrThrow(
        arbitraryForSchema(closed.schema),
        (payload) => {
          const result = withStar.validateFacetWrite('demo.closed/v0', payload)
          return result.ok ? undefined : result.message
        },
        'demo.closed/v0',
      ),
    ).toThrow(/nothing drawn for demo\.closed\/v0 is accepted/)
    expect(() => facetsArbitrary(withStar, 'node')).not.toThrow()
  })

  it('draws the empty record for a target with no facet', () => {
    expect(fc.sample(facetsArbitrary(createFacetRegistry([]), 'canvas'), 5)).toEqual([
      {},
      {},
      {},
      {},
      {},
    ])
  })
})
