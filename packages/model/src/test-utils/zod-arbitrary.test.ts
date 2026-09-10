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

type Tree = { readonly value: number; readonly children: Tree[] }
const treeSchema: z.ZodType<Tree> = z.lazy(() =>
  z.object({ value: z.number(), children: z.array(treeSchema) }),
)
type Inline = { readonly type: 'text'; value: string } | { readonly type: 'em'; children: Inline[] }
const inlineSchema: z.ZodType<Inline> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('em'), children: z.array(inlineSchema).min(1) }),
    z.object({ type: z.literal('text'), value: z.string() }),
  ]),
)

const CASES: ReadonlyArray<readonly [string, z.ZodTypeAny]> = [
  ['object of primitives', z.object({ a: z.string(), b: z.number(), c: z.boolean() })],
  [
    'optional and nullable fields',
    z.object({ a: z.string().optional(), b: z.number().nullable() }),
  ],
  ['defaulted field', z.object({ a: z.enum(['x', 'y']).default('x') })],
  ['strict object', z.strictObject({ a: z.literal('only') })],
  ['loose object', z.object({ a: z.string() }).loose()],
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
  ['url as a method', z.string().url()],
  ['url as a schema', z.url()],
  ['starts-with string', z.string().startsWith('#')],
  ['two formats on one string', z.string().startsWith('a').endsWith('z')],
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
  ['catch and prefault', z.object({ a: z.string().catch('x'), b: z.number().prefault(1) })],
  ['unknown value', z.object({ any: z.unknown() })],
  ['refined object', z.object({ a: z.number(), b: z.number() }).refine((v) => v.a <= v.b)],
  ['recursive object', treeSchema],
  ['recursive union with a non-empty array', inlineSchema],
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
    const drawn = fc.sample(arbitraryForSchema(schema), 300)
    expect(new Set(drawn.map((v) => v.kind))).toEqual(new Set(['ellipse', 'diamond', 'hexagon']))
    expect(new Set(drawn.map((v) => ('icon' in v.symbol ? 'icon' : 'emoji')))).toEqual(
      new Set(['icon', 'emoji']),
    )
    expect(new Set(drawn.map((v) => v.routing === undefined))).toEqual(new Set([true, false]))
  })

  it('draws an optional key as absent, never as a key holding undefined', () => {
    // `{ a: undefined }` equals `{}` to `toEqual` and to nothing that
    // serialises; a property over storage would pass a shape the store
    // never sees. A default is left to the parse for the same reason: the
    // key absent on the input side is how the default branch gets drawn.
    const schema = z.object({
      a: z.string().optional(),
      b: z.string().optional().catch(undefined),
      c: z.number().default(7),
    })
    const drawn = fc.sample(arbitraryForSchema(schema), 200)
    for (const value of drawn) {
      for (const key of ['a', 'b'] as const) {
        if (key in value) expect(value[key]).not.toBeUndefined()
      }
      expect(value.c).toBeTypeOf('number')
    }
    expect(drawn.some((value) => value.c === 7)).toBe(true)
    expect(drawn.some((value) => value.c !== 7)).toBe(true)
  })

  it('hands back the output side: a default filled, a transform applied', () => {
    const schema = z.object({ n: z.string().transform((s) => s.length), d: z.number().default(1) })
    for (const value of fc.sample(arbitraryForSchema(schema), 50)) {
      expect(value.n).toBeTypeOf('number')
      expect(value.d).toBeTypeOf('number')
    }
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
    for (const value of fc.sample(arbitrary, 50)) {
      if (value.theme !== undefined) expect(value.theme).toBe('visual.sketch')
      expect(value.nested.ref).toBe('icon:1')
    }
  })

  it('lets an override match a shared schema by identity wherever it appears', () => {
    const idSchema = z.string()
    const schema = z.object({
      from: idSchema,
      to: idSchema.optional(),
      items: z.array(z.object({ ref: idSchema })),
    })
    const arbitrary = arbitraryForSchema(schema, {
      override: (_path, candidate) => (candidate === idSchema ? fc.constant('ID') : undefined),
    })
    for (const value of fc.sample(arbitrary, 50)) {
      expect(value.from).toBe('ID')
      if (value.to !== undefined) expect(value.to).toBe('ID')
      for (const item of value.items) expect(item.ref).toBe('ID')
    }
  })

  it('bounds a recursive schema by maxDepth and reaches the ceiling', () => {
    const depthOf = (tree: Tree): number =>
      tree.children.length === 0 ? 0 : 1 + Math.max(...tree.children.map(depthOf))
    for (const maxDepth of [0, 1, 2]) {
      const depths = fc.sample(arbitraryForSchema(treeSchema, { maxDepth }), 300).map(depthOf)
      expect(Math.max(...depths)).toBe(maxDepth)
    }
    // A union at the ceiling keeps only the arms that need no expansion.
    const inlines = fc.sample(arbitraryForSchema(inlineSchema, { maxDepth: 0 }), 100)
    expect(inlines.every((inline) => inline.type === 'text')).toBe(true)
    expect(
      fc
        .sample(arbitraryForSchema(inlineSchema, { maxDepth: 1 }), 200)
        .some((v) => v.type === 'em'),
    ).toBe(true)
  })

  it('throws instead of retrying forever when nothing drawn is accepted', () => {
    // A refinement nothing satisfies would make fast-check's filter loop
    // synchronously with no timeout to catch it; the decision is taken at
    // construction, with the schema's own first complaint — at the field
    // that carries the refinement, since that is where it is filtered.
    expect(() =>
      arbitraryForSchema(z.object({ a: z.string().refine(() => false, 'never') })),
    ).toThrow(/nothing drawn for the schema at \$\.a is accepted \(first rejection: never\)/)
  })

  it('keeps a refined union arm and a refined array element reachable at their own rate', () => {
    // Filtered only at the root, the arm with no refinement would dominate
    // and one rejected element would reject the whole collection.
    const schema = z.object({
      anchor: z.discriminatedUnion('kind', [
        z
          .object({ kind: z.literal('spatial'), a: z.number(), b: z.number() })
          .refine((v) => v.a < v.b),
        z.object({ kind: z.literal('document') }),
      ]),
      items: z.array(z.object({ n: z.number() }).refine((v) => v.n > 0)),
    })
    const drawn = fc.sample(arbitraryForSchema(schema), 400)
    const spatial = drawn.filter((v) => v.anchor.kind === 'spatial').length
    expect(spatial).toBeGreaterThan(120)
    expect(spatial).toBeLessThan(280)
    expect(drawn.some((v) => v.items.length >= 2)).toBe(true)
  })

  it('throws naming the path for a construct it has no generator for', () => {
    expect(() => arbitraryForSchema(z.object({ when: z.date() }))).toThrow(
      /no generator for zod "date" at \$\.when/,
    )
    expect(() => arbitraryForSchema(z.object({ items: z.array(z.set(z.string())) }))).toThrow(
      /"set" at \$\.items\[\]/,
    )
    // A format whose regex fast-check cannot build a generator from (lookaheads).
    expect(() => arbitraryForSchema(z.object({ to: z.string().email() }))).toThrow(
      /string format "email" at \$\.to/,
    )
  })

  it('throws naming the path for a recursion nothing can end', () => {
    type Chain = { next: Chain }
    const chain: z.ZodType<Chain> = z.lazy(() => z.object({ next: chain }))
    expect(() => arbitraryForSchema(chain, { maxDepth: 2 })).toThrow(
      /recursion at \$\.next\.next\.next cannot end within maxDepth 2/,
    )
  })
})
