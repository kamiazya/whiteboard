// @vitest-environment node
// The generator's own honesty: every canvas facet the bundled registry holds
// is actually produced, and nothing it produces is refused by the registry
// — a generator that silently skipped a facet would leave a property green
// over a surface it never reached.
import { bundledFacetRegistry } from '@kamiazya/whiteboard-plugin-visual'
import { describe, expect, it } from 'vitest'
import { facetEntries, facetsArbitrary } from './facet-arbitrary.js'
import { fc } from './fast-check.js'

describe('facetsArbitrary over the bundled registry', () => {
  it('produces every canvas facet the registry holds, and only payloads it accepts', () => {
    const entries = facetEntries(bundledFacetRegistry, 'canvas')
    expect(entries.length).toBeGreaterThanOrEqual(3)
    const seen = new Set<string>()
    for (const facets of fc.sample(facetsArbitrary(bundledFacetRegistry, 'canvas'), 300)) {
      for (const [key, payload] of Object.entries(facets)) {
        seen.add(key)
        expect(bundledFacetRegistry.validateFacetWrite(key, payload).ok, key).toBe(true)
      }
    }
    expect([...seen].sort()).toEqual(entries.map((entry) => entry.key).sort())
  })
})
