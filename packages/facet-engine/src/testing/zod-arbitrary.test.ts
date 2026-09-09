// The generator's contract, schema by schema: everything it draws is
// accepted by the schema it was drawn from, every finite choice is reached,
// and a construct it has no generator for THROWS naming the path — never
// yields nothing, which is how a property stays green over a facet it does
// not reach.
import { test as fcTest } from '@fast-check/vitest'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { arbitraryForSchema } from './zod-arbitrary.js'

const numRuns = 200

const CASES: ReadonlyArray<readonly [string, z.ZodTypeAny]> = [
  ['object of primitives', z.object({ a: z.string(), b: z.number(), c: z.boolean() })],
  [
    'optional and nullable fields',
    z.object({ a: z.string().optional(), b: z.number().nullable() }),
  ],
  ['defaulted field', z.object({ a: z.enum(['x', 'y']).default('x') })],
  ['strict object', z.strictObject({ a: z.literal('only') })],
  ['enum', z.enum(['ellipse', 'diamond', 'hexagon'])],
  ['object enum', z.enum({ A: 'a', B: 'b' })],
  ['literal set', z.literal(['a', 1, true])],
  ['null and undefined', z.tuple([z.null(), z.undefined()])],
  ['integer with bounds', z.number().int().min(-3).max(7)],
  ['exclusive bounds', z.number().gt(0).lt(1)],
  ['nonnegative double', z.number().nonnegative()],
  ['int32', z.int32()],
  ['string length', z.object({ one: z.string().length(1), some: z.string().min(2).max(3) })],
  ['regex string', z.string().regex(/^#[0-9a-f]{6}$/)],
  ['uuid string', z.string().uuid()],
  ['union of objects', z.union([z.object({ k: z.literal('a') }), z.object({ k: z.literal('b') })])],
  [
    'discriminated union',
    z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('icon'), name: z.string().min(1) }),
      z.object({ kind: z.literal('emoji'), char: z.string().length(1) }),
    ]),
  ],
  [
    'array with bounds',
    z
      .array(z.enum(['p', 'q']))
      .min(1)
      .max(2),
  ],
  ['tuple', z.tuple([z.string(), z.number()])],
  ['tuple with rest', z.tuple([z.literal('head')]).rest(z.boolean())],
  ['record of strings', z.record(z.string(), z.number())],
  ['record over enum keys', z.record(z.enum(['a', 'b']), z.boolean())],
  ['readonly object', z.object({ a: z.string() }).readonly()],
  ['pipe keeps the input side', z.string().transform((s) => s.length)],
  ['catch and prefault', z.object({ a: z.string().catch('x'), b: z.number().prefault(1) })],
  ['unknown value', z.object({ any: z.unknown() })],
  ['refined object', z.object({ a: z.number(), b: z.number() }).refine((v) => v.a <= v.b)],
]

describe('arbitraryForSchema', () => {
  for (const [title, schema] of CASES) {
    fcTest.prop([arbitraryForSchema(schema)], { numRuns })(
      `draws only what the schema accepts: ${title}`,
      (value) => {
        expect(schema.safeParse(value).success, JSON.stringify(value)).toBe(true)
      },
    )
  }

  it('reaches every enum value, every union arm and both sides of an optional field', () => {
    const schema = z.object({
      kind: z.enum(['ellipse', 'diamond', 'hexagon']),
      symbol: z.union([z.object({ icon: z.string() }), z.object({ emoji: z.string() })]),
      routing: z.enum(['straight', 'curved']).optional(),
    })
    const drawn = fc.sample(arbitraryForSchema(schema), 300) as Array<z.infer<typeof schema>>
    expect(new Set(drawn.map((v) => v.kind))).toEqual(new Set(['ellipse', 'diamond', 'hexagon']))
    expect(new Set(drawn.map((v) => ('icon' in v.symbol ? 'icon' : 'emoji')))).toEqual(
      new Set(['icon', 'emoji']),
    )
    expect(new Set(drawn.map((v) => v.routing === undefined))).toEqual(new Set([true, false]))
  })

  it('honours a refinement the walk cannot see, by filtering rather than by luck', () => {
    // A single grapheme cluster: '🔥' is two code units, so a length-1 check
    // would drop it while a grapheme check keeps it. The generator only
    // hands back what the schema itself accepts.
    const schema = z.string().refine((s) => [...new Intl.Segmenter().segment(s)].length === 1)
    for (const value of fc.sample(arbitraryForSchema(schema), 100)) {
      expect(schema.safeParse(value).success, JSON.stringify(value)).toBe(true)
    }
  })

  it('lets an override replace the generator at a named path, inside an optional field too', () => {
    const schema = z.object({ theme: z.string().optional(), nested: z.object({ ref: z.string() }) })
    const arbitrary = arbitraryForSchema(schema, {
      override: (path) => {
        if (path === '$.theme') return fc.constant('visual.sketch')
        if (path === '$.nested.ref') return fc.constant('icon:1')
        return undefined
      },
    })
    for (const value of fc.sample(arbitrary, 50) as Array<z.infer<typeof schema>>) {
      if (value.theme !== undefined) expect(value.theme).toBe('visual.sketch')
      expect(value.nested.ref).toBe('icon:1')
    }
  })

  it('throws instead of retrying forever when nothing drawn is accepted', () => {
    // A refinement nothing satisfies would make fast-check's filter loop
    // synchronously with no timeout to catch it; the decision is taken at
    // construction, with the schema's own first complaint.
    expect(() =>
      arbitraryForSchema(z.object({ a: z.string().refine(() => false, 'never') })),
    ).toThrow(/nothing drawn for the schema at \$ is accepted \(first rejection: never\)/)
  })

  it('throws naming the path for a construct it has no generator for', () => {
    expect(() => arbitraryForSchema(z.object({ when: z.date() }))).toThrow(
      /no generator for zod "date" at \$\.when/,
    )
    expect(() => arbitraryForSchema(z.object({ items: z.array(z.set(z.string())) }))).toThrow(
      /"set" at \$\.items\[\]/,
    )
    expect(() => arbitraryForSchema(z.string().url())).toThrow(/string format "url" at \$/)
    // A format whose regex fast-check cannot build a generator from (lookaheads).
    expect(() => arbitraryForSchema(z.object({ to: z.string().email() }))).toThrow(
      /string format "email" at \$\.to/,
    )
  })
})
