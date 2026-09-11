import { type CensusFacet, censusSpatialModel } from '@kamiazya/whiteboard-codec'
import { bundledFacetRegistry } from '@kamiazya/whiteboard-plugin-visual'
import { describe, expect, it } from 'vitest'

/**
 * How far JSON Canvas 1.0 reaches into the spatial model this product
 * actually ships, counted from the schemas rather than from a corpus.
 *
 * The standing question it answers: a whiteboard document IS a JSON Canvas
 * document plus one extension key, so what share of what the product means
 * is in the format, and what share is in the key the format leaves blank?
 * A corpus cannot answer that — it answers what somebody happened to draw.
 *
 * Both numbers are pinned so a change to either is read rather than merged.
 * There is no target: a rising extension count is the measurement, not a
 * regression, and the decision it feeds is whether the model should keep
 * being the wire format at all.
 */
const bundledFacets: readonly CensusFacet[] = bundledFacetRegistry.plugins.flatMap((plugin) =>
  plugin.facets.map((facet) => ({
    key: `${plugin.id}.${facet.name}/${facet.version}`,
    targets: facet.targets,
    schema: facet.schema,
  })),
)

const census = censusSpatialModel(bundledFacets)

describe('how far JSON Canvas 1.0 reaches into the shipped spatial model', () => {
  it('states 23 leaf fields of its own', () => {
    expect(census.standard).toHaveLength(23)
  })

  it('leaves 12 named leaf fields to the extension key', () => {
    expect(census.extension).toHaveLength(12)
  })

  it('cannot see inside the three facet buckets, which is why they are counted apart', () => {
    expect(census.facetBuckets).toHaveLength(3)
  })

  it('carries 15 more field positions in those buckets from the one bundled plugin', () => {
    // Positions, not facets: a facet targeting both a node and the canvas can
    // be written at either, and each is somewhere a reader has to look.
    expect(census.facet).toHaveLength(15)
  })

  it('so 27 of the 50 field positions a document can hold are outside the format', () => {
    const outside = census.extension.length + census.facet.length
    expect(outside).toBe(27)
    expect(outside + census.standard.length).toBe(50)
  })
})
