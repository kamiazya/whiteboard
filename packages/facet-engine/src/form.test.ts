// Tier 1 of the editor ladder: a facet with no hand-written widget still
// gets an editor, derived from the schema it already declares. The
// derivation answers DATA (a field list in a closed vocabulary) — the
// rendering vessel is each surface's own.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { deriveFacetForm } from './form.js'
import { defineFacet } from './registry.js'
import { visualShapeFacetSchema, visualSymbolFacetSchema } from './visual.js'

describe('deriveFacetForm', () => {
  it('humanizes a derived label — the fallback should not read like a variable', () => {
    const form = deriveFacetForm(z.object({ dueDate: z.string(), snake_case: z.string() }))
    if (form.kind !== 'fields') throw new Error('unreachable')
    expect(form.fields.map((f) => f.label)).toEqual(['Due date', 'Snake case'])
    // The NAME is untouched: it is the storage key, not a caption.
    expect(form.fields.map((f) => f.name)).toEqual(['dueDate', 'snake_case'])
  })

  it('maps an object of primitives to one field each, in declaration order', () => {
    const form = deriveFacetForm(
      z.object({
        title: z.string(),
        count: z.number(),
        done: z.boolean(),
      }),
    )
    expect(form).toEqual({
      kind: 'fields',
      fields: [
        { name: 'title', label: 'Title', control: { kind: 'text' }, required: true, quick: false },
        {
          name: 'count',
          label: 'Count',
          control: { kind: 'number' },
          required: true,
          quick: false,
        },
        { name: 'done', label: 'Done', control: { kind: 'toggle' }, required: true, quick: false },
      ],
    })
  })

  it('maps an enum to a choice control carrying its options', () => {
    const form = deriveFacetForm(visualShapeFacetSchema)
    expect(form.kind).toBe('fields')
    if (form.kind !== 'fields') throw new Error('unreachable')
    expect(form.fields).toHaveLength(1)
    expect(form.fields[0]?.name).toBe('kind')
    expect(form.fields[0]?.control).toEqual({
      kind: 'choice',
      options: ['ellipse', 'diamond', 'hexagon', 'parallelogram', 'cylinder'],
    })
  })

  it('marks an optional field not required and unwraps it', () => {
    const form = deriveFacetForm(z.object({ note: z.string().optional() }))
    if (form.kind !== 'fields') throw new Error('unreachable')
    expect(form.fields[0]).toEqual({
      name: 'note',
      label: 'Note',
      control: { kind: 'text' },
      required: false,
      quick: false,
    })
  })

  it('answers a variants form for a discriminated union, one per arm', () => {
    const form = deriveFacetForm(visualSymbolFacetSchema)
    expect(form.kind).toBe('variants')
    if (form.kind !== 'variants') throw new Error('unreachable')
    expect(form.variants.map((v) => v.label)).toEqual(['icon', 'emoji'])
    // The literal that selects the arm is not a field the human fills in.
    expect(form.variants[0]?.fields.map((f) => f.name)).toEqual(['name'])
    expect(form.variants[1]?.fields.map((f) => f.name)).toEqual(['char'])
    expect(form.discriminant).toBe('kind')
  })

  it('distinguishes optional from default, and a chain of both', () => {
    // `required` drives only emphasis today, but the three wrapper
    // combinations answer differently and nothing else pins which is which.
    const form = deriveFacetForm(
      z.object({
        plain: z.string(),
        opt: z.string().optional(),
        def: z.string().default('x'),
        both: z.string().default('x').optional(),
      }),
    )
    if (form.kind !== 'fields') throw new Error('unreachable')
    expect(form.fields.map((f) => [f.name, f.required])).toEqual([
      ['plain', true],
      ['opt', false],
      ['def', true],
      ['both', false],
    ])
  })

  it('rejects a union it cannot present as variants, each way separately', () => {
    // A non-object arm — the OTHER arm is a well-formed discriminated
    // object, so the rejection can only come from the bad arm itself.
    expect(
      deriveFacetForm(z.union([z.object({ kind: z.literal('a'), v: z.string() }), z.string()]))
        .kind,
    ).toBe('unsupported')
    // An arm with no string literal to select it by.
    expect(
      deriveFacetForm(
        z.union([z.object({ kind: z.literal('a'), v: z.string() }), z.object({ v: z.string() })]),
      ).kind,
    ).toBe('unsupported')
    // Arms discriminated on DIFFERENT field names — each is fine alone.
    expect(
      deriveFacetForm(
        z.union([
          z.object({ kind: z.literal('a'), v: z.string() }),
          z.object({ type: z.literal('b'), v: z.string() }),
        ]),
      ).kind,
    ).toBe('unsupported')
    // Two arms selected by the SAME literal: a variant picker could not
    // tell them apart, and the second would be unreachable.
    expect(
      deriveFacetForm(
        z.union([
          z.object({ kind: z.literal('a'), v: z.string() }),
          z.object({ kind: z.literal('a'), w: z.string() }),
        ]),
      ).kind,
    ).toBe('unsupported')
    // An arm whose non-discriminant member is outside the vocabulary.
    expect(
      deriveFacetForm(
        z.union([
          z.object({ kind: z.literal('a'), v: z.string() }),
          z.object({ kind: z.literal('b'), v: z.array(z.string()) }),
        ]),
      ).kind,
    ).toBe('unsupported')
  })

  it('answers unsupported for a schema outside the closed vocabulary', () => {
    // A nested object is not a tier-1 form: the fallback is honest about
    // needing a real widget rather than rendering half the payload.
    expect(deriveFacetForm(z.object({ nested: z.object({ a: z.string() }) })).kind).toBe(
      'unsupported',
    )
    expect(deriveFacetForm(z.string()).kind).toBe('unsupported')
    expect(deriveFacetForm(z.array(z.string())).kind).toBe('unsupported')
  })
})

describe('an editor spec refines the derived form', () => {
  const schema = z.object({
    kind: z.enum(['ellipse', 'diamond']),
    label: z.string().optional(),
  })

  it('a field may declare a richer control from the catalog, with per-option glyphs', () => {
    const form = deriveFacetForm(schema, {
      fields: {
        kind: {
          widget: 'segmented',
          label: 'Shape',
          quick: true,
          options: [
            { value: 'ellipse', label: 'Ellipse', glyph: 'circle' },
            { value: 'diamond', label: 'Diamond', glyph: 'diamond' },
          ],
        },
      },
    })
    if (form.kind !== 'fields') throw new Error('unreachable')
    const [first, second] = form.fields
    expect(first).toEqual({
      name: 'kind',
      label: 'Shape',
      quick: true,
      control: {
        kind: 'segmented',
        options: [
          { value: 'ellipse', label: 'Ellipse', glyph: 'circle' },
          { value: 'diamond', label: 'Diamond', glyph: 'diamond' },
        ],
      },
      required: true,
    })
    // A field the spec says nothing about keeps its derived control.
    expect(second?.control).toEqual({ kind: 'text' })
    expect(second?.quick).toBe(false)
  })

  it('a spec may add an ABSENCE option, since some defaults are unrepresentable', () => {
    // `visual.shape` has no 'rect' value — rect IS the absent facet — so a
    // picker needs a way to say "clear this".
    const form = deriveFacetForm(schema, {
      fields: {
        kind: {
          widget: 'segmented',
          options: [
            { value: null, label: 'Rectangle', glyph: 'square' },
            { value: 'ellipse', label: 'Ellipse', glyph: 'circle' },
          ],
        },
      },
    })
    if (form.kind !== 'fields') throw new Error('unreachable')
    const control = form.fields[0]?.control
    expect(control?.kind === 'segmented' && control.options[0]?.value).toBeNull()
  })

  it('a spec naming a field the schema does not have is rejected at definition time', () => {
    expect(() =>
      defineFacet({
        name: 'sample',
        displayName: 'Sample',
        version: 'v0',
        targets: ['node'],
        schema,
        editor: { fields: { nope: { widget: 'segmented', options: [] } } },
      }),
    ).toThrow(/nope/)
  })

  it('a spec on a schema with no derivable form is rejected too', () => {
    expect(() =>
      defineFacet({
        name: 'sample',
        displayName: 'Sample',
        version: 'v0',
        targets: ['node'],
        schema: z.string(),
        editor: { fields: { kind: { widget: 'text' } } },
      }),
    ).toThrow(/form/)
  })
})
