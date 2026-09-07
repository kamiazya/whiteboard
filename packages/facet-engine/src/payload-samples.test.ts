import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { facetPayloadSamples } from './payload-samples.js'
import { defineFacet } from './registry.js'

const nodeFacet = <S extends z.ZodTypeAny>(name: string, schema: S, editor?: never) =>
  defineFacet({
    name,
    displayName: name,
    version: 'v0',
    targets: ['node'],
    schema,
    ...(editor === undefined ? {} : { editor }),
  })

describe('facetPayloadSamples', () => {
  it('covers every value of an enum field', () => {
    const samples = facetPayloadSamples(
      nodeFacet('shape', z.object({ kind: z.enum(['ellipse', 'diamond', 'hexagon']) })),
    )
    expect(new Set(samples.map((s) => (s as { kind: string }).kind))).toEqual(
      new Set(['ellipse', 'diamond', 'hexagon']),
    )
  })

  it('covers every arm of a discriminated union', () => {
    const samples = facetPayloadSamples(
      nodeFacet(
        'symbol',
        z.union([
          z.object({ kind: z.literal('icon'), name: z.string().min(1) }),
          z.object({ kind: z.literal('emoji'), char: z.string().length(1) }),
        ]),
      ),
    )
    expect(new Set(samples.map((s) => (s as { kind: string }).kind))).toEqual(
      new Set(['icon', 'emoji']),
    )
  })

  it('drops a candidate its facet schema rejects, rather than handing back a payload no reader resolves', () => {
    // `.length(1)` is invisible to the form layer (a text field is a text
    // field), so 'sample' is generated and must not survive.
    const samples = facetPayloadSamples(
      nodeFacet('badge', z.object({ char: z.string().length(1) })),
    )
    expect(samples.length).toBeGreaterThan(0)
    for (const sample of samples) {
      expect((sample as { char: string }).char).toHaveLength(1)
    }
  })

  it('draws an optional field as absent as well as present', () => {
    const samples = facetPayloadSamples(
      nodeFacet('edges', z.object({ routing: z.enum(['straight', 'curved']).optional() })),
    )
    expect(samples.some((s) => (s as { routing?: string }).routing === undefined)).toBe(true)
    expect(samples.some((s) => (s as { routing?: string }).routing !== undefined)).toBe(true)
  })

  it('answers empty for a schema the form layer cannot express', () => {
    expect(facetPayloadSamples(nodeFacet('opaque', z.record(z.string(), z.unknown())))).toEqual([])
  })
})
