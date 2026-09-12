// The wrapper's own contract: the registry's payloads arrive in the shape
// the model stores, and the absent extension is drawn as `undefined`, not
// as an empty bucket.
import { createFacetRegistry, defineFacet, definePlugin } from '@kamiazya/whiteboard-facet-engine'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { facetsArb } from './facet-arbitraries.js'
import { fc } from './fast-check.js'

const shapeFacet = defineFacet({
  name: 'shape',
  displayName: 'Shape',
  version: 'v0',
  targets: ['node'],
  schema: z.object({ kind: z.enum(['ellipse', 'diamond']) }),
})
const registry = createFacetRegistry([
  definePlugin({ id: 'demo', displayName: 'Demo', facets: [shapeFacet] }),
])

describe('facetsArb', () => {
  it('draws every registered payload, and the absent bucket too', () => {
    const drawn = fc.sample(facetsArb(registry, 'node'), 200)
    const kinds = new Set(
      drawn.map((x) => (x?.['demo.shape/v0'] as { kind?: string } | undefined)?.kind),
    )
    expect(kinds).toEqual(new Set([undefined, 'ellipse', 'diamond']))
    expect(drawn.filter((x) => x === undefined).length).toBeGreaterThan(0)
    expect(drawn.some((x) => x !== undefined && Object.keys(x).length === 0)).toBe(false)
  })

  it('draws only the absent bucket for a registry with no facet', () => {
    expect(fc.sample(facetsArb(createFacetRegistry([]), 'node'), 20)).toEqual(
      Array.from({ length: 20 }, () => undefined),
    )
  })
})
