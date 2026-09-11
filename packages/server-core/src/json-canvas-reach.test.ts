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
 * Since ADR-0035 the model no longer spells the format's key, so the split is
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
  it("states 21 of the model's field positions exactly", () => {
    // 19 -> 21 with ADR-0035 slice 3: an END is one object rather than three
    // flat keys, and the object's `kind` is a position of its own on each
    // side. The format states it in the only sense that matters — every JSON
    // Canvas edge runs between two nodes, so `kind` crossing means the lift
    // builds the node arm and nothing is lost.
    expect(withKind('native')).toHaveLength(21)
  })

  it('cannot state 4 at all — a free end, which takes its whole edge with it', () => {
    // The ledger's first `dropped` entries, and the first loss whose UNIT is
    // the element rather than the field: JSON Canvas requires `fromNode` and
    // `toNode`, so an edge with a free end is omitted from BOTH modes. It is
    // named here rather than left to the loss table because a `dropped` kind
    // appearing at all is the thing to read in a diff.
    expect([...withKind('dropped')].sort()).toEqual([
      'edges[].from.point.x',
      'edges[].from.point.y',
      'edges[].to.point.x',
      'edges[].to.point.y',
    ])
  })

  it('states 4 more only to the nearest whole pixel — a node box', () => {
    // The format HAS these fields, so they are not outside it; what it cannot
    // say is a fraction. Since ADR-0035 slice 4 the model's geometry is real,
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

  it('carries 14 further field positions inside those buckets, from one bundled plugin', () => {
    // Positions, not facets: a facet targeting both a node and the canvas can
    // be written at either, and each is somewhere a reader has to look.
    // 13 -> 14 when the bundled plugin gained `visual.stencil/v0` (ADR-0034).
    // The column that grows when a deployment adds plugins is exactly the one
    // this scoreboard exists to watch, so the move is the reading rather than
    // a regression.
    expect(census.facet).toHaveLength(14)
  })

  it('so 34 of the 59 positions a document can hold are outside the format', () => {
    // 29/52 -> 33/58 with ADR-0035 slice 3, and the two numbers move for
    // DIFFERENT reasons, which is the reading. The denominator grew by six
    // because an endpoint object has positions three flat keys did not (a
    // `kind` and a `point`'s two coordinates, per end). The numerator grew by
    // four because all four point coordinates are `dropped`.
    //
    // So the share outside went 55.8% -> 56.9%, and what actually changed is
    // not that the format reaches less far — it is that the model now holds
    // something the format has no vocabulary for at all, where before it held
    // only things the format could state or the extension key could carry.
    // That is the first position of its kind since ADR-0035 was accepted.
    const outside = withKind('extension').length + withKind('dropped').length + census.facet.length
    // 33/58 -> 34/59 with ADR-0034's stencil facet, which lands INSIDE a
    // bucket: the format could already say nothing about what a bucket holds,
    // so the share outside moves 56.9% -> 57.6% on a position the format was
    // never going to reach.
    expect(outside).toBe(34)
    expect(outside + withKind('native').length + withKind('degraded').length).toBe(59)
  })
})
