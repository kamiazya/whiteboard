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
 * Since ADR-0037 the model no longer spells the format's key, so the split is
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
    // 19 -> 21 with ADR-0037 slice 3 (an END became one object, and its `kind`
    // was a position of its own per side), and 21 -> 19 with ADR-0038
    // decision 2, which took those two `kind` positions off an edge again: an
    // edge's end names a node and nothing else, so there is no discriminator
    // left to state.
    expect(withKind('native')).toHaveLength(19)
  })

  it('cannot state NOTHING at all any more, which is what the split bought', () => {
    // The ledger's `dropped` column is EMPTY, and it is the most surprising
    // consequence of ADR-0038 decision 2. It held four entries — an edge's
    // point ends, the only loss whose unit was the ELEMENT rather than the
    // field, because JSON Canvas requires `fromNode` and `toNode` and omitted
    // such an edge from both modes.
    //
    // Splitting the relation from the ink did not teach the format anything.
    // It stopped asking the format to carry ink as a relation: a line is a
    // line now, the whole collection rides the extension key, and what a
    // strict reader loses is ink rather than a malformed edge.
    expect([...withKind('dropped')].sort()).toEqual([])
  })

  it('states 4 more only to the nearest whole pixel — a node box', () => {
    // The format HAS these fields, so they are not outside it; what it cannot
    // say is a fraction. Since ADR-0037 slice 4 the model's geometry is real,
    // so the box is the ledger's first `degraded` entry, and this pin is what
    // makes a second one a decision rather than a merge.
    expect([...withKind('degraded')].sort()).toEqual([
      'nodes[].height',
      'nodes[].width',
      'nodes[].x',
      'nodes[].y',
    ])
  })

  it('leaves 34 to the extension key — 30 named fields and 4 facet buckets', () => {
    // 16 -> 34, and almost all of it is one collection: a LINE's 18 positions
    // all ride `x-whiteboard.lines`. A line between two nodes COULD be emitted
    // as a JSON Canvas edge and read better in a foreign tool; that is the lie
    // the split removes, since the format's edge asserts a connection the line
    // deliberately does not claim.
    expect(withKind('extension')).toHaveLength(34)
    expect(census.facetBuckets).toHaveLength(4)
  })

  it('carries 14 further field positions inside those buckets, from one bundled plugin', () => {
    // Positions, not facets: a facet targeting both a node and the canvas can
    // be written at either, and each is somewhere a reader has to look.
    // 13 -> 14 when the bundled plugin gained `visual.stencil/v0` (ADR-0034).
    // The column that grows when a deployment adds plugins is exactly the one
    // this scoreboard exists to watch, so the move is the reading rather than
    // a regression.
    //
    // 14 -> 15 for `facets["visual.axes/v0"].axes[]` (ADR-0036): the one
    // position where a canvas names which of its own facets carry MEANING
    // rather than appearance. CANVAS only, and that is the design — an axis
    // is a statement about the whole drawing, so the same key on a node says
    // nothing a reader could act on, and it adds one position rather than
    // two. It is `extension` for the ordinary reason every facet is: JSON
    // Canvas has no vocabulary for "this attribute is a semantic axis".
    expect(census.facet).toHaveLength(15)
  })

  it('so 48 of the 71 positions a document can hold are outside the format', () => {
    // Both numbers move for DIFFERENT reasons, which is the reading.
    //
    // The denominator grew by 14 because a LINE is a new element with its own
    // 18 positions, while an EDGE lost 6 (two `kind` discriminators and four
    // point coordinates). The numerator grew by 14 because every one of the
    // line's positions is `extension` and the four `dropped` ones are gone.
    //
    // So the share outside went 57.6% -> 65.8%, and what changed is NOT that
    // the format reaches less far into what it can state. It is that the model
    // grew a concept the format has no vocabulary for — ink that is not a
    // relation — and put it where a strict reader loses it cleanly instead of
    // where the format refused the whole element. `dropped` going to zero in
    // the same move is the other half of that sentence.
    //
    // 48/71 -> 49/72: both move by exactly the one facet position above, so
    // the share outside is 65.8% -> 68.1%. A position that only ever lives in
    // the extension raises both halves of the ratio together, which is what
    // makes it a different kind of move from the line's — that one changed
    // the numerator and denominator by different amounts and for different
    // reasons.
    const outside = withKind('extension').length + withKind('dropped').length + census.facet.length
    expect(outside).toBe(49)
    expect(outside + withKind('native').length + withKind('degraded').length).toBe(72)
  })
})
