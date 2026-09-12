// An asset-ref field's OPTIONS come from the registry, not from the facet
// definition (ADR-0034 decision 4's UI half).
//
// The defect this closes: `visual.theme` and `visual.stencil` each listed
// their ids by hand in an `editor` spec, so a deployment or a community pack
// could REGISTER a stencil that `wb_facet_list` reported, `wb_canvas_edit`
// applied — and the editor's picker did not offer. "Registered but
// unselectable" is the shape an ecosystem cannot ship with.
//
// The engine already holds both halves: the definition declares the WIDGET,
// and the registry holds the assets. So the seam is `registry.facetForm`,
// which is already the one place a form is built.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createFacetRegistry, defineFacet, definePlugin } from './registry.js'
import { SAMPLE_THEME_TOKENS } from './theme-tokens.js'

const stencilFacet = defineFacet({
  name: 'stencil',
  displayName: 'Stencil',
  version: 'v0',
  targets: ['node'],
  schema: z.object({ stencil: z.string().min(1) }),
  assetRefs: { stencil: 'stencils' },
  // Declares the WIDGET and no options: the registry supplies those.
  editor: { fields: { stencil: { widget: 'segmented', label: 'Stencil' } } },
})

const paint = definePlugin({
  id: 'paint',
  displayName: 'Paint',
  facets: [stencilFacet],
  assets: {
    stencils: { bare: { displayName: 'Bare' } },
    themes: { chalk: SAMPLE_THEME_TOKENS },
  },
})

const pack = definePlugin({
  id: 'pack',
  displayName: 'Pack',
  facets: [],
  assets: { stencils: { bucket: { displayName: 'Bucket' }, queue: { displayName: 'Queue' } } },
})

const optionsOf = (registry: ReturnType<typeof createFacetRegistry>) => {
  const form = registry.facetForm('paint.stencil/v0')
  if (form.kind !== 'fields') throw new Error(`expected a fields form, got ${form.kind}`)
  const field = form.fields.find((f) => f.name === 'stencil')
  if (field?.control.kind !== 'segmented') {
    throw new Error(`expected a segmented control, got ${field?.control.kind}`)
  }
  return field.control.options
}

describe('an asset-ref field is offered the registered assets', () => {
  it('offers every registered stencil, including a pack this repo did not ship', () => {
    const options = optionsOf(createFacetRegistry([paint, pack]))
    expect(options.map((option) => option.value)).toEqual([
      null,
      'paint.bare',
      'pack.bucket',
      'pack.queue',
    ])
  })

  it('labels each by what the asset calls itself, not by its id', () => {
    const options = optionsOf(createFacetRegistry([paint, pack]))
    expect(options.find((option) => option.value === 'pack.bucket')?.label).toBe('Bucket')
  })

  it('offers a null first, since the field is optional and absent is a real answer', () => {
    // A stencil is a choice a box may simply not have made. Without this the
    // picker can dress a box and never undress it.
    expect(optionsOf(createFacetRegistry([paint]))[0]).toEqual({ value: null, label: 'None' })
  })

  it('reads the KIND the field declares, so a theme ref is offered themes', () => {
    const themed = definePlugin({
      id: 'themed',
      displayName: 'Themed',
      facets: [
        defineFacet({
          name: 'look',
          displayName: 'Look',
          version: 'v0',
          targets: ['canvas'],
          schema: z.object({ theme: z.string().min(1) }),
          assetRefs: { theme: 'themes' },
          editor: { fields: { theme: { widget: 'segmented' } } },
        }),
      ],
      assets: { themes: { dusk: SAMPLE_THEME_TOKENS } },
    })
    const form = createFacetRegistry([paint, themed]).facetForm('themed.look/v0')
    if (form.kind !== 'fields') throw new Error('expected a fields form')
    const control = form.fields[0]?.control
    if (control?.kind !== 'segmented') throw new Error('expected a segmented control')
    // Themes, not the stencils the other plugin registered.
    expect(control.options.map((option) => option.value)).toEqual([
      null,
      'paint.chalk',
      'themed.dusk',
    ])
  })

  it('answers an empty registry with the null option alone, never a broken picker', () => {
    const empty = definePlugin({
      id: 'empty',
      displayName: 'Empty',
      facets: [
        defineFacet({
          name: 'stencil',
          displayName: 'Stencil',
          version: 'v0',
          targets: ['node'],
          schema: z.object({ stencil: z.string().min(1) }),
          assetRefs: { stencil: 'stencils' },
          editor: { fields: { stencil: { widget: 'segmented' } } },
        }),
      ],
    })
    const form = createFacetRegistry([empty]).facetForm('empty.stencil/v0')
    if (form.kind !== 'fields') throw new Error('expected a fields form')
    const control = form.fields[0]?.control
    if (control?.kind !== 'segmented') throw new Error('expected a segmented control')
    expect(control.options).toEqual([{ value: null, label: 'None' }])
  })

  it('leaves a field that is NOT an asset ref exactly as its spec declares', () => {
    // The registry supplies values only where it is the authority. A plain
    // enum field is the plugin's own vocabulary and must not be touched.
    const plain = definePlugin({
      id: 'plain',
      displayName: 'Plain',
      facets: [
        defineFacet({
          name: 'shape',
          displayName: 'Shape',
          version: 'v0',
          targets: ['node'],
          schema: z.object({ kind: z.enum(['ellipse', 'hexagon']) }),
        }),
      ],
      assets: { stencils: { decoy: { displayName: 'Decoy' } } },
    })
    const form = createFacetRegistry([plain, pack]).facetForm('plain.shape/v0')
    if (form.kind !== 'fields') throw new Error('expected a fields form')
    const control = form.fields[0]?.control
    // A bare enum with no editor spec derives `choice`, and that is the
    // point: the registry did not reach in and turn it into an asset
    // picker, even though this very plugin registers a stencil.
    if (control?.kind !== 'choice') throw new Error(`expected a choice, got ${control?.kind}`)
    expect(control.options).toEqual(['ellipse', 'hexagon'])
  })
})

// 足場3b: the CARDS half of the same promise (user decision, 2026-09-12).
//
// The field case above was closed first and left a sibling open: a picker
// that writes WHOLE payloads and draws each option as a card could not be
// filled from the registry, because a card needs a picture and the options
// the registry built carried none. So `visual.theme` kept listing its ids by
// hand — registered but unselectable, one layout later.
//
// The engine cannot name the picture itself: the mark belongs to a plugin,
// and this package knows no plugin. So the FACET names it once, and the
// registry supplies the ids and draws each through that asset's own tokens.
const SPECIMEN = 'paint.squiggle'

const themed = defineFacet({
  name: 'look',
  displayName: 'Look',
  version: 'v0',
  targets: ['canvas'],
  schema: z.object({ theme: z.string().min(1) }),
  assetRefs: { theme: 'themes' },
  // The specimen and no options: one mark, and the registry says how many
  // times to draw it.
  editor: { picker: { layout: 'cards', specimenIcon: SPECIMEN } },
})

const studio = definePlugin({
  id: 'paint',
  displayName: 'Paint',
  facets: [themed],
  assets: {
    themes: { chalk: SAMPLE_THEME_TOKENS, ember: SAMPLE_THEME_TOKENS },
    icons: { squiggle: { geometry: [{ tag: 'path', d: 'M2 12 C 6 4, 12 20, 22 6' }] } },
  },
})

const cardsOf = (registry: ReturnType<typeof createFacetRegistry>) => {
  const form = registry.facetForm('paint.look/v0')
  if (form.kind !== 'picker') throw new Error(`expected a picker form, got ${form.kind}`)
  return form
}

describe('a themed picker draws one specimen per registered theme', () => {
  it('offers a card per theme, led by the absent-facet card', () => {
    const form = cardsOf(createFacetRegistry([studio]))
    expect(form.layout).toBe('cards')
    expect(form.options.map((option) => option.payload)).toEqual([
      null,
      { theme: 'paint.chalk' },
      { theme: 'paint.ember' },
    ])
  })

  it('names each card from the id, which is what the hand-written labels already said', () => {
    // `assetLabel` derives "Chalk" from `paint.chalk`, so a theme carries no
    // display name of its own and needs none. The two labels written by hand
    // on `visual.theme` today — Sketch, Neon — are character-for-character
    // what this produces for `visual.sketch` and `visual.neon`.
    const form = cardsOf(createFacetRegistry([studio]))
    expect(form.options.map((option) => option.label)).toEqual(['Default', 'Chalk', 'Ember'])
  })

  it('draws the SAME mark each time, through each theme’s own tokens', () => {
    // The whole reason the `theme` glyph arm exists: an option choosing a
    // look has to show the look, and `asset` draws one flat stroke in
    // `currentColor` — two themes would be one picture twice.
    const form = cardsOf(createFacetRegistry([studio]))
    expect(form.options.map((option) => option.glyph)).toEqual([
      { kind: 'asset', id: SPECIMEN },
      { kind: 'theme', id: 'paint.chalk', icon: SPECIMEN },
      { kind: 'theme', id: 'paint.ember', icon: SPECIMEN },
    ])
  })

  it('grows with a pack this repo did not ship, which is the whole promise', () => {
    // ADR-0030 decision 2: registering a theme needs no UI edit anywhere.
    const community = definePlugin({
      id: 'dusk',
      displayName: 'Dusk',
      facets: [],
      assets: { themes: { velvet: SAMPLE_THEME_TOKENS } },
    })
    const form = cardsOf(createFacetRegistry([studio, community]))
    expect(form.options.map((option) => option.label)).toEqual([
      'Default',
      'Chalk',
      'Ember',
      'Velvet',
    ])
    expect(form.options.at(-1)?.glyph).toEqual({
      kind: 'theme',
      id: 'dusk.velvet',
      icon: SPECIMEN,
    })
  })

  it('refuses a specimen picker whose ref is not a single theme, at definition time', () => {
    // The mechanism means "drawn the way this asset draws", and a theme is
    // the only asset that draws. A stencil id is not icon geometry, so the
    // same shape over stencils would put a broken picture on every card —
    // refused here rather than rendered, because empty boxes in a picker are
    // worse than a plugin that does not load.
    const specimen = (assetRefs: Record<string, 'themes' | 'stencils' | 'icons'>) =>
      defineFacet({
        name: 'bad',
        displayName: 'Bad',
        version: 'v0',
        targets: ['canvas'],
        schema: z.object({ theme: z.string().min(1), stencil: z.string().min(1) }),
        assetRefs,
        editor: { picker: { layout: 'cards', specimenIcon: SPECIMEN } },
      })
    expect(() => specimen({ stencil: 'stencils' })).toThrow(/kind "themes"/)
    expect(() => specimen({ theme: 'themes', stencil: 'stencils' })).toThrow(/exactly one/)
  })

  it('still refuses a picker that declares neither options nor a specimen', () => {
    // The original error, kept: an option-less picker is legal only in the
    // one shape the registry can fill.
    expect(() =>
      defineFacet({
        name: 'empty',
        displayName: 'Empty',
        version: 'v0',
        targets: ['canvas'],
        schema: z.object({ theme: z.string().min(1) }),
        assetRefs: { theme: 'themes' },
        editor: { picker: { layout: 'cards' } },
      }),
    ).toThrow(/picker with no options/)
  })

  it('leaves a picker that wrote its own options exactly as it declared them', () => {
    // The registry fills what was NOT declared. A picker listing its own
    // options is making a choice the registry cannot second-guess — an arm
    // it wants left out, an order it means.
    const fixed = defineFacet({
      name: 'fixed',
      displayName: 'Fixed',
      version: 'v0',
      targets: ['canvas'],
      schema: z.object({ theme: z.string().min(1) }),
      assetRefs: { theme: 'themes' },
      editor: {
        picker: {
          layout: 'cards',
          specimenIcon: SPECIMEN,
          options: [{ payload: { theme: 'paint.chalk' }, label: 'Only chalk' }],
        },
      },
    })
    const registry = createFacetRegistry([
      definePlugin({
        id: 'paint',
        displayName: 'Paint',
        facets: [fixed],
        assets: { themes: { chalk: SAMPLE_THEME_TOKENS, ember: SAMPLE_THEME_TOKENS } },
      }),
    ])
    const form = registry.facetForm('paint.fixed/v0')
    if (form.kind !== 'picker') throw new Error(`expected a picker form, got ${form.kind}`)
    expect(form.options.map((option) => option.label)).toEqual(['Only chalk'])
  })
})
