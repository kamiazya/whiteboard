import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { coreFacetsSchema, extensionFacetsSchema, facetsRawSchema } from './facets.js'
import * as generated from './generated/okf.zod.js'
import { fc, withDefaults } from './test-utils/fast-check.js'
import { okfActorSchema, okfTimestampSchema, okfTrustEventSchema } from './trust.js'

// Mirrors `okfMarkdownFrontmatterSchema` in packages/codec/src/okf/schema.ts,
// which model cannot import. Held here until the codec takes the generated one.
const okfMarkdownFrontmatterSchema = coreFacetsSchema.extend({
  generated: okfTrustEventSchema.optional(),
  verified: z.array(okfTrustEventSchema).optional(),
  facets: extensionFacetsSchema.optional(),
  facetsRaw: facetsRawSchema.optional(),
})

const pairs: ReadonlyArray<readonly [string, z.ZodType, z.ZodType]> = [
  ['okfActor', okfActorSchema, generated.okfActorSchema],
  ['okfTimestamp', okfTimestampSchema, generated.okfTimestampSchema],
  ['okfTrustEvent', okfTrustEventSchema, generated.okfTrustEventSchema],
  ['coreFacets', coreFacetsSchema, generated.coreFacetsSchema],
  ['extensionFacets', extensionFacetsSchema, generated.extensionFacetsSchema],
  ['facetsRaw', facetsRawSchema, generated.facetsRawSchema],
  ['okfMarkdownFrontmatter', okfMarkdownFrontmatterSchema, generated.okfMarkdownFrontmatterSchema],
]

// An empty registry: the hand-written facet buckets are named in zod's global
// registry, which the generated ones do not (yet) join, and naming only moves
// a shape between `$defs` and its use site.
const unnamed = { metadata: z.registry<{ id?: string }>() }

const keys = [
  'type',
  'title',
  'description',
  'resource',
  'tags',
  'view',
  'generated',
  'verified',
  'facets',
  'facetsRaw',
  'by',
  'at',
  'visual.shape/v0',
  'bad key',
  'x-extra',
  '__proto__',
  '0',
]
const strings = fc.oneof(
  fc.string({ maxLength: 8 }),
  fc.constantFrom(
    '',
    ' ',
    ' a',
    'a ',
    'a\nb',
    '\u{feff}a',
    '\u{85}',
    'human:a',
    'team:ga4-docs',
    '2026-11-09T12:00:00Z',
    '2026-11-09T12:00:00.5+09:00',
    '2026-11-09',
    '2026-11-09T12:00:00',
    'visual.shape/v0',
    'a.b/v1',
    'A.b/v1',
    'tags',
  ),
)
const leaf = fc.oneof(
  strings,
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
  fc.constant(undefined),
)
const value: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
  tree: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    leaf,
    fc.array(tie('tree'), { maxLength: 3 }),
    fc.dictionary(fc.constantFrom(...keys), tie('tree'), { maxKeys: 5 }),
  ),
})).tree
const trustEvent = fc.record({ by: strings, at: strings, extra: leaf }, { requiredKeys: [] })
const frontmatter = fc.record(
  {
    type: strings,
    title: strings,
    description: strings,
    resource: strings,
    tags: fc.array(strings, { maxLength: 3 }),
    view: strings,
    generated: trustEvent,
    verified: fc.array(trustEvent, { maxLength: 3 }),
    facets: fc.dictionary(fc.constantFrom(...keys), value, { maxKeys: 4 }),
    facetsRaw: fc.dictionary(fc.constantFrom(...keys), value, { maxKeys: 4 }),
    other: leaf,
  },
  { requiredKeys: [] },
)
// Mostly well-formed, so the accepted side of every schema is reached in bulk.
const goodEvent = fc.record(
  {
    by: fc.constantFrom('human:a', 'a/1', 'team:ga4-docs'),
    at: fc.constantFrom('2026-11-09T12:00:00Z', '2026-11-09T12:00:00.5+09:00'),
    extra: leaf,
  },
  { requiredKeys: ['by', 'at'] },
)
const goodKey = fc.constantFrom('visual.shape/v0', 'a.b/v1', 'x-y.z/v22')
const goodRawKey = fc.constantFrom('x-extra', 'Type', 'other', '0')
const wellFormed = fc.record(
  {
    type: fc.constantFrom('note', 'a'),
    title: strings,
    description: strings,
    resource: strings,
    tags: fc.array(strings, { maxLength: 3 }),
    view: strings,
    generated: goodEvent,
    verified: fc.array(goodEvent, { maxLength: 3 }),
    facets: fc.dictionary(goodKey, value, { maxKeys: 3 }),
    facetsRaw: fc.dictionary(goodRawKey, value, { maxKeys: 3 }),
    other: leaf,
  },
  { requiredKeys: ['type'] },
)
const inputs = fc.oneof(value, strings, trustEvent, goodEvent, frontmatter, wellFormed, wellFormed)

describe('the generated OKF schemas against the hand-written ones', () => {
  it.each(pairs)('%s publishes the same JSON Schema on both sides of the wire', (_, hand, gen) => {
    for (const io of ['input', 'output'] as const) {
      expect(z.toJSONSchema(gen, { ...unnamed, io })).toEqual(
        z.toJSONSchema(hand, { ...unnamed, io }),
      )
    }
  })

  it.each(pairs)('%s answers the same on every input drawn', (_, hand, gen) => {
    fc.assert(
      fc.property(inputs, (input) => {
        const a = hand.safeParse(input)
        const b = gen.safeParse(input)
        expect(b.success).toBe(a.success)
        if (a.success && b.success) expect(b.data).toEqual(a.data)
        else if (!a.success && !b.success) expect(b.error.issues).toEqual(a.error.issues)
      }),
      withDefaults(),
    )
  })

  it('the draw reaches accepted and refused frontmatter alike', () => {
    const outcomes = fc
      .sample(inputs, 400)
      .filter((input) => typeof input === 'object' && input !== null && !Array.isArray(input))
      .map((input) => generated.okfMarkdownFrontmatterSchema.safeParse(input).success)
    expect(outcomes.filter(Boolean).length).toBeGreaterThan(40)
    expect(outcomes.filter((ok) => !ok).length).toBeGreaterThan(40)
    expect(outcomes.length).toBeGreaterThan(150)
  })
})
