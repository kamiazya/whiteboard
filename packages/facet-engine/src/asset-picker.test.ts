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
