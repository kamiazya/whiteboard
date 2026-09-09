// @vitest-environment node
// The registry-drawn generator against the BUNDLED registry: every canvas
// facet the `visual` plugin holds is actually produced, and nothing produced
// is refused by the registry. facet-engine tests the mechanism over demo
// facets; this is the check that the plugin this app ships has no facet the
// walk cannot express — which would throw at construction — and none it
// quietly skips.
import { facetEntries, facetsArbitrary } from '@kamiazya/whiteboard-facet-engine/testing'
import { bundledFacetRegistry } from '@kamiazya/whiteboard-plugin-visual'
import { describe, expect, it } from 'vitest'
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
