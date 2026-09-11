import {
  type CensusFacet,
  censusSpatialModel,
  type FieldProjection,
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
 * Every kind is pinned so a change to any of them is read rather than merged.
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
const kindOf = (path: string) => JSON_CANVAS_PROJECTION[path]?.kind
const withKind = (kind: FieldProjection['kind']) =>
  positions.filter((path) => kindOf(path) === kind)

describe('how far JSON Canvas 1.0 reaches into the shipped spatial model', () => {
  it("states 19 of the model's field positions exactly", () => {
    expect(withKind('native')).toHaveLength(19)
  })

  it('states 4 more only to the nearest whole pixel — a node box', () => {
    // The format HAS these fields, so they are not outside it; what it cannot
    // say is a fraction. Since ADR-0033 slice 4 the model's geometry is real,
    // so the box is the ledger's first `degraded` entry, and this pin is what
    // makes a second one a decision rather than a merge.
    expect([...withKind('degraded')].sort()).toEqual([
      'nodes[].height',
      'nodes[].width',
      'nodes[].x',
      'nodes[].y',
    ])
  })

  it('leaves 16 to the extension key — 13 named fields and 3 facet buckets', () => {
    expect(withKind('extension')).toHaveLength(16)
    expect(census.facetBuckets).toHaveLength(3)
  })

  it('carries 13 further field positions inside those buckets, from one bundled plugin', () => {
    // Positions, not facets: a facet targeting both a node and the canvas can
    // be written at either, and each is somewhere a reader has to look.
    expect(census.facet).toHaveLength(13)
  })

  it('so 29 of the 52 positions a document can hold are outside the format', () => {
    // Both totals are unchanged by ADR-0033 slice 4 and that is the reading,
    // not a coincidence: an edge's two bend coordinates MOVED, out of a
    // plugin's bucket (`visual.path/v0`, retired) and into the edge's own
    // `bends` — 14 named extension fields became 16 and the 15 positions
    // inside the buckets became 13. What the format cannot state is the
    // same; what the PRODUCT has to call a plugin's is two fewer.
    const outside = withKind('extension').length + withKind('dropped').length + census.facet.length
    expect(outside).toBe(29)
    expect(outside + withKind('native').length + withKind('degraded').length).toBe(52)
  })
})
