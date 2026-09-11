import {
  type CensusFacet,
  censusSpatialModel,
  JSON_CANVAS_PROJECTION,
} from '@kamiazya/whiteboard-codec'
import { bundledFacetRegistry } from '@kamiazya/whiteboard-plugin-visual'
import { describe, expect, it } from 'vitest'

/**
 * How far JSON Canvas 1.0 reaches into the spatial model this product
 * actually ships, counted from the schemas rather than from a corpus.
 *
 * The standing question it answers: the product supports JSON Canvas as a
 * first-class format, so what share of what a document MEANS does that format
 * state, and what share only survives the one extension key? A corpus cannot
 * answer that — it answers what somebody happened to draw.
 *
 * Since ADR-0033 the model no longer spells the format's key, so the split is
 * the projection LEDGER's answer rather than a prefix test. That is the point
 * of the ledger: one authority on what a position costs an export.
 *
 * Both numbers are pinned so a change to either is read rather than merged.
 * There is no target — a rising outside count is the measurement, not a
 * regression.
 */
const bundledFacets: readonly CensusFacet[] = bundledFacetRegistry.plugins.flatMap((plugin) =>
  plugin.facets.map((facet) => ({
    key: `${plugin.id}.${facet.name}/${facet.version}`,
    targets: facet.targets,
    schema: facet.schema,
  })),
)

const census = censusSpatialModel(bundledFacets)
const positions = [...census.paths, ...census.facetBuckets]
const isNative = (path: string) => JSON_CANVAS_PROJECTION[path]?.kind === 'native'

describe('how far JSON Canvas 1.0 reaches into the shipped spatial model', () => {
  it("states 23 of the model's field positions itself", () => {
    expect(positions.filter(isNative)).toHaveLength(23)
  })

  it('leaves 14 more to the extension key — 11 named fields and 3 facet buckets', () => {
    expect(positions.filter((path) => !isNative(path))).toHaveLength(14)
    expect(census.facetBuckets).toHaveLength(3)
  })

  it('carries 15 further field positions inside those buckets, from one bundled plugin', () => {
    // Positions, not facets: a facet targeting both a node and the canvas can
    // be written at either, and each is somewhere a reader has to look.
    expect(census.facet).toHaveLength(15)
  })

  it('so 29 of the 52 positions a document can hold are outside the format', () => {
    const outside = positions.filter((path) => !isNative(path)).length + census.facet.length
    expect(outside).toBe(29)
    expect(outside + positions.filter(isNative).length).toBe(52)
  })
})
