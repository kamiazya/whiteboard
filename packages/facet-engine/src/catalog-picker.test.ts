/**
 * A picker that is OPEN: more choices than a row can hold, and — when it
 * says so — values nobody listed at all.
 *
 * `visual.symbol`'s emoji arm accepts any single grapheme, and the picker
 * offered five. The schema was never the restriction; the vocabulary was,
 * because every option had to be written out in the definition and the
 * definition is loaded by the renderer, the layout worker and the MCP
 * server alike. So a catalog is declared as a LOADER rather than a list,
 * and free entry is declared as the shape a typed value is folded into —
 * both data, neither a component.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { deriveFacetForm } from './form.js'
import { defineFacet } from './registry.js'

const symbolSchema = z.union([
  z.object({ kind: z.literal('icon'), name: z.string().min(1) }),
  z.object({ kind: z.literal('emoji'), char: z.string().min(1) }),
])

const sections = [
  {
    label: 'Smileys',
    options: [
      {
        payload: { kind: 'emoji', char: '😀' },
        label: 'grinning face',
        keywords: ['face smiling'],
      },
    ],
  },
]

const catalog = {
  label: 'Search symbols',
  load: async () => sections,
  entry: { label: 'Any emoji', payload: { kind: 'emoji' }, field: 'char' },
}

describe('a picker may carry a catalog', () => {
  it('keeps the listed options inline and hands the loader through', async () => {
    const form = deriveFacetForm(symbolSchema, {
      picker: { options: [{ payload: null, label: 'No symbol' }], catalog },
    })

    expect(form.kind).toBe('picker')
    if (form.kind !== 'picker') throw new Error('not a picker')
    expect(form.options.map((option) => option.label)).toEqual(['No symbol'])
    expect(form.catalog?.label).toBe('Search symbols')
    // The loader is not called deriving the form — that is the whole point
    // of declaring one. A definition that loaded its catalog eagerly would
    // put the rows in every graph that imports the plugin.
    expect(await form.catalog?.load()).toEqual(sections)
  })

  it('carries the keywords an option is findable by, beside its label', async () => {
    const form = deriveFacetForm(symbolSchema, {
      picker: { options: [{ payload: null, label: 'No symbol' }], catalog },
    })
    if (form.kind !== 'picker') throw new Error('not a picker')
    const loaded = await form.catalog?.load()
    expect(loaded?.[0]?.options[0]?.keywords).toEqual(['face smiling'])
  })
})

describe('free entry is checked against the facet it writes', () => {
  const define =
    (entry: { label: string; payload: Record<string, unknown>; field: string }): (() => unknown) =>
    () =>
      defineFacet({
        name: 'symbol',
        displayName: 'Symbol',
        version: 'v0',
        targets: ['node'],
        schema: symbolSchema,
        editor: {
          picker: {
            options: [{ payload: null, label: 'No symbol' }],
            catalog: { ...catalog, entry },
          },
        },
      })

  it('accepts a template the typed value completes', () => {
    expect(define({ label: 'Any emoji', payload: { kind: 'emoji' }, field: 'char' })).not.toThrow()
  })

  /**
   * A template that already parses means the typed text changes nothing
   * that had to change — so the control writes a valid payload the moment
   * it is drawn, before anybody has typed. That reads as a picker with a
   * silent extra option, which is the shape a declared picker exists to
   * make impossible.
   */
  it('refuses a template its schema already accepts on its own', () => {
    expect(
      define({ label: 'Any icon', payload: { kind: 'icon', name: 'database' }, field: 'tone' }),
    ).toThrow(/writes a payload its schema accepts before anything is typed/)
  })

  /** Two sources for one key, and only one of them can win. */
  it('refuses a template that already fills the field the text goes in', () => {
    expect(
      define({ label: 'Any emoji', payload: { kind: 'emoji', char: '📌' }, field: 'char' }),
    ).toThrow(/already fills "char"/)
  })

  it('refuses a catalog with nothing to call its search', () => {
    expect(() =>
      defineFacet({
        name: 'symbol',
        displayName: 'Symbol',
        version: 'v0',
        targets: ['node'],
        schema: symbolSchema,
        editor: {
          picker: {
            options: [{ payload: null, label: 'No symbol' }],
            catalog: { ...catalog, label: '  ' },
          },
        },
      }),
    ).toThrow(/needs a non-blank catalog label/)
  })
})
