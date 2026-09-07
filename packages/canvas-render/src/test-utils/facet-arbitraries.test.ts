// The guard's own guard. `nodeFacetCoverage` is what makes a facet added
// later arrive in every property built on it, so its two failure modes —
// missing a registered node facet, and reporting one as covered when it
// derives nothing — have to be visible rather than assumed.
import { createFacetRegistry, defineFacet, definePlugin } from '@kamiazya/whiteboard-facet-engine'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { nodeFacetCoverage, nodeFacetsArb } from './facet-arbitraries.js'
import { fc } from './fast-check.js'

const registryWith = (...facets: Parameters<typeof definePlugin>[0]['facets']) =>
  createFacetRegistry([definePlugin({ id: 'demo', displayName: 'Demo', facets })])

const shapeFacet = defineFacet({
  name: 'shape',
  displayName: 'Shape',
  version: 'v0',
  targets: ['node'],
  schema: z.object({ kind: z.enum(['ellipse', 'diamond']) }),
})

describe('nodeFacetCoverage', () => {
  it('reports a node facet the sample deriver cannot express, instead of omitting it', () => {
    const opaque = defineFacet({
      name: 'opaque',
      displayName: 'Opaque',
      version: 'v0',
      targets: ['node'],
      schema: z.record(z.string(), z.unknown()),
    })
    const coverage = nodeFacetCoverage(registryWith(shapeFacet, opaque))
    expect(coverage.map((entry) => entry.key)).toEqual(['demo.shape/v0', 'demo.opaque/v0'])
    // The property's completeness guard reads exactly this.
    expect(coverage.filter((entry) => entry.samples.length === 0).map((e) => e.key)).toEqual([
      'demo.opaque/v0',
    ])
  })

  it('leaves out a facet that targets something other than a node', () => {
    const canvasOnly = defineFacet({
      name: 'edges',
      displayName: 'Edges',
      version: 'v0',
      targets: ['canvas'],
      schema: z.object({ routing: z.enum(['straight', 'curved']) }),
    })
    expect(nodeFacetCoverage(registryWith(shapeFacet, canvasOnly)).map((e) => e.key)).toEqual([
      'demo.shape/v0',
    ])
  })
})

describe('nodeFacetsArb', () => {
  it('draws every registered payload, and the absent facet too', () => {
    const drawn = fc.sample(nodeFacetsArb(registryWith(shapeFacet)), 200)
    const kinds = new Set(
      drawn.map((x) => {
        const payload = x?.facets?.['demo.shape/v0'] as { kind?: string } | undefined
        return payload?.kind
      }),
    )
    expect(kinds).toEqual(new Set([undefined, 'ellipse', 'diamond']))
  })

  it('draws nothing for a registry with no derivable node facet', () => {
    expect(fc.sample(nodeFacetsArb(createFacetRegistry([])), 20)).toEqual(
      Array.from({ length: 20 }, () => undefined),
    )
  })
})
