// Tier 1 of the editor ladder: a facet with no hand-written widget still
// gets an editor, derived from the schema it already declares. The
// derivation answers DATA (a field list in a closed vocabulary) — the
// rendering vessel is each surface's own.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { deriveFacetForm } from './form.js'
import { visualShapeFacetSchema, visualSymbolFacetSchema } from './visual.js'

describe('deriveFacetForm', () => {
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
        { name: 'title', label: 'title', control: { kind: 'text' }, required: true },
        { name: 'count', label: 'count', control: { kind: 'number' }, required: true },
        { name: 'done', label: 'done', control: { kind: 'toggle' }, required: true },
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
      label: 'note',
      control: { kind: 'text' },
      required: false,
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
