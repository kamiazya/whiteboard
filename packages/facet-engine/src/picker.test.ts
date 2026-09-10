/**
 * A facet-level PICKER: one control that writes a whole payload.
 *
 * The field-level `segmented` control cannot express the commonest shape a
 * facet actually has. `visual.symbol` is a union of two arms (`icon` with a
 * name, `emoji` with a character) and its twelve choices straddle both, so
 * a control that writes ONE FIELD has nothing to write — which is why that
 * facet was given a hand-written component instead, and why the settings
 * panel ended up drawing four different-looking pickers for one job.
 *
 * A picker option carries the payload, so the arms stop mattering. `null`
 * is the option that says the facet should not exist, and it is the ONE
 * way to say that — a facet with a picker needs no Clear beside it.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { deriveFacetForm, facetPayloadKey } from './form.js'
import { defineFacet } from './registry.js'

const symbolSchema = z.union([
  z.object({ kind: z.literal('icon'), name: z.string().min(1) }),
  z.object({ kind: z.literal('emoji'), char: z.string().min(1) }),
])

const themeSchema = z.object({ theme: z.string().min(1) })

describe('a declared picker', () => {
  it('derives one control whose options span the schema arms', () => {
    const form = deriveFacetForm(symbolSchema, {
      picker: {
        options: [
          { payload: null, label: 'No symbol', glyph: { kind: 'shape', name: 'none' } },
          {
            payload: { kind: 'icon', name: 'database' },
            label: 'Database',
            glyph: { kind: 'asset', id: 'visual.database' },
          },
          {
            payload: { kind: 'emoji', char: '📌' },
            label: 'Pin',
            glyph: { kind: 'char', value: '📌' },
          },
        ],
      },
    })

    expect(form.kind).toBe('picker')
    if (form.kind !== 'picker') throw new Error('not a picker')
    expect(form.options.map((option) => option.label)).toEqual(['No symbol', 'Database', 'Pin'])
    // The union derives a `variants` form on its own; the picker WINS,
    // because a spec is the plugin saying how this facet is met.
    expect(deriveFacetForm(symbolSchema).kind).toBe('variants')
  })

  it('serves a plain object schema too, so one vocabulary covers every row', () => {
    const form = deriveFacetForm(themeSchema, {
      picker: {
        options: [
          { payload: null, label: 'Default' },
          { payload: { theme: 'visual.neon' }, label: 'Neon' },
        ],
      },
    })
    expect(form.kind).toBe('picker')
  })

  it('refuses a payload its own schema would reject, at definition time', () => {
    expect(() =>
      defineFacet({
        name: 'symbol',
        displayName: 'Symbol',
        version: 'v0',
        targets: ['node'],
        schema: symbolSchema,
        editor: {
          picker: {
            options: [
              // `nmae`, not `name` — the typo a hand-written component
              // would have shipped and nothing would have caught.
              { payload: { kind: 'icon', nmae: 'database' }, label: 'Database' },
            ],
          },
        },
      }),
    ).toThrow(/picker option "Database"/)
  })

  // Key ORDER is a writer's accident, never a difference in value. Both
  // places that compared payloads used `JSON.stringify` directly and each
  // had a hole: this one would admit a duplicate, and the vessel's "which
  // option is current" would match nothing at all for a stored value whose
  // keys arrived in another order — a picker drawn with no selection, from
  // a facet `wb_facet_set` or an imported document wrote perfectly validly.
  it('keys a payload by value, not by the order its keys were written', () => {
    expect(facetPayloadKey({ kind: 'icon', name: 'database' })).toBe(
      facetPayloadKey({ name: 'database', kind: 'icon' }),
    )
    // Nested, and through an array, since a payload is not always flat.
    expect(facetPayloadKey({ a: { x: 1, y: [{ p: 1, q: 2 }] } })).toBe(
      facetPayloadKey({ a: { y: [{ q: 2, p: 1 }], x: 1 } }),
    )
    // Still distinguishes what really differs, including absence.
    expect(facetPayloadKey({ kind: 'icon', name: 'database' })).not.toBe(
      facetPayloadKey({ kind: 'icon', name: 'file' }),
    )
    expect(facetPayloadKey(undefined)).toBe(facetPayloadKey(null))
  })

  it('refuses two options that write the same payload in a different key order', () => {
    expect(() =>
      defineFacet({
        name: 'symbol',
        displayName: 'Symbol',
        version: 'v0',
        targets: ['node'],
        schema: symbolSchema,
        editor: {
          picker: {
            options: [
              { payload: { kind: 'icon', name: 'database' }, label: 'Database' },
              { payload: { name: 'database', kind: 'icon' }, label: 'Database again' },
            ],
          },
        },
      }),
    ).toThrow(/same payload/)
  })

  it('refuses two options that write the same payload', () => {
    expect(() =>
      defineFacet({
        name: 'theme',
        displayName: 'Theme',
        version: 'v0',
        targets: ['canvas'],
        schema: themeSchema,
        editor: {
          picker: {
            options: [
              { payload: { theme: 'visual.neon' }, label: 'Neon' },
              { payload: { theme: 'visual.neon' }, label: 'Neon again' },
            ],
          },
        },
      }),
    ).toThrow(/same payload/)
  })

  it('refuses a spec declaring both a picker and fields', () => {
    expect(() =>
      defineFacet({
        name: 'theme',
        displayName: 'Theme',
        version: 'v0',
        targets: ['canvas'],
        schema: themeSchema,
        editor: {
          picker: { options: [{ payload: null, label: 'Default' }] },
          fields: { theme: { widget: 'text' } },
        },
      }),
    ).toThrow(/both a picker and fields/)
  })
})
