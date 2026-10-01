import { describe, expect, it } from 'vitest'
import { visualShapeFacetSchema } from './data.js'
import { visualRenderContribution } from './render.js'

/**
 * What a document may SAY (`visual.shape/v0`'s enum) and what this plugin
 * can DRAW (its render contribution) are two lists in two files of one
 * package, and nothing tied them together: `octagon` entered the enum with
 * its silhouette written into the renderer's own copy of this table, so the
 * plugin alone could not draw a kind it declared, and the renderer's
 * fallback hid that for as long as the copy lived. Both directions, so a
 * kind cannot be reachable only by hand either.
 */
describe('the shapes visual declares are the shapes visual draws', () => {
  const declared = visualShapeFacetSchema.shape.kind.options
  const drawn = Object.keys(visualRenderContribution.shapes ?? {})

  it('finds a plausible number of kinds, so an empty pass is not a broken read', () => {
    expect(declared.length).toBeGreaterThanOrEqual(5)
  })

  it('draws every kind the facet may declare', () => {
    expect(declared.filter((kind) => !drawn.includes(kind))).toEqual([])
  })

  it('declares every kind it draws', () => {
    expect(drawn.filter((kind) => !declared.includes(kind as (typeof declared)[number]))).toEqual(
      [],
    )
  })
})
