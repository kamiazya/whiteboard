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

describe('a facet that declares its own samples', () => {
  const pathFacet = (samples?: readonly unknown[]) =>
    defineFacet({
      name: 'path',
      displayName: 'Bends',
      version: 'v0',
      targets: ['edge'],
      schema: z.object({ waypoints: z.array(z.object({ x: z.number(), y: z.number() })).min(1) }),
      ...(samples === undefined ? {} : { samples }),
    })

  it('answers with them where the form layer can express nothing', () => {
    // A list of points has no control in the derived vocabulary, so this
    // facet's samples cannot be derived — and a generator over the registry
    // would silently cover it by nothing.
    expect(facetPayloadSamples(pathFacet())).toEqual([])
    expect(facetPayloadSamples(pathFacet([{ waypoints: [{ x: 1, y: 2 }] }]))).toEqual([
      { waypoints: [{ x: 1, y: 2 }] },
    ])
  })

  it('drops a declared sample its own schema refuses, the way a derived one is dropped', () => {
    // The declaration is written by hand and the schema moves without it, so
    // it is checked exactly like a derived candidate — a stale sample must
    // not reach a generator as a payload no reader resolves.
    expect(
      facetPayloadSamples(pathFacet([{ waypoints: [] }, { waypoints: [{ x: 1, y: 2 }] }])),
    ).toEqual([{ waypoints: [{ x: 1, y: 2 }] }])
  })

  it('is refused at definition time on a facet the form layer CAN express', () => {
    // Otherwise the declaration is dead: derived samples would answer and
    // nothing would say the hand-written list is never read.
    expect(() =>
      defineFacet({
        name: 'shape',
        displayName: 'Shape',
        version: 'v0',
        targets: ['node'],
        schema: z.object({ kind: z.enum(['ellipse', 'diamond']) }),
        samples: [{ kind: 'ellipse' }],
      }),
    ).toThrow(/samples/)
  })
})
