import type { FieldProjection } from './projection.js'

/**
 * What projecting this model onto **OCIF v0.7.0** costs, position by
 * position — the sibling of `JSON_CANVAS_PROJECTION`, and the measurement
 * that comes before any decision about adopting the format's decompositions.
 *
 * The four kinds mean something slightly different here, and the difference
 * is most of why this table is worth having:
 *
 * - `native` — OCIF states it. Note that OCIF's `native` is much WIDER than
 *   JSON Canvas's, because extensions are part of the format rather than one
 *   vendor key: a facet bucket, an embedded document and the annotation layer
 *   are all things OCIF can carry as itself.
 * - `extension` — carried on an extension this project declares. OCIF's
 *   conformance rules require an implementation to PRESERVE extensions it
 *   does not understand, so unlike JSON Canvas's strict mode there is no
 *   second mode that drops these. They survive a round trip through a
 *   conforming foreign tool; what they do not survive is that tool
 *   UNDERSTANDING them.
 * - `degraded` — crosses as something else, named in `to`.
 * - `dropped` — cannot cross.
 *
 * Sources: the v0.7.0 specification (Candidate Recommendation) at
 * https://spec.canvasprotocol.org/ — file structure, node properties,
 * resources, the extension mechanism, and the built-in `@ocif/*` extensions.
 *
 * Five entries here were written from the specification alone and corrected
 * by `ocif-projection-io.ts` and the foreign-reader comparison beside this
 * table. Each correction is commented at its row, because what a table gets
 * wrong when it is read rather than run is the most useful thing it records.
 */

const NATIVE = { kind: 'native' } as const
const EXTENSION = { kind: 'extension' } as const

/**
 * OCIF has no node `type`. What a node IS comes from the resource it shows
 * and the extensions it carries — the spec is explicit that "there is no
 * special text node in OCIF. Text is a kind of resource."
 *
 * So the discriminator does not cross as a field. The INFORMATION survives
 * (a reader can still tell a group from a note) but it survives as a
 * different shape, which is what `degraded` is for — and `fromOcif` earns
 * the word by deriving the kind from the mime type and `@ocif/group` rather
 * than from anything of ours.
 */
const AS_SHAPE = {
  kind: 'degraded',
  to: "the node's resource and extensions — OCIF has no node type field, so what a node IS comes from what it shows and what it carries",
} as const

/**
 * Colour was written `degraded` here from the spec — OCIF's shape extensions
 * take a concrete `fillColor`, so a preset index would have to be resolved on
 * the way out and would arrive having lost the theme role it named.
 *
 * Writing the projection corrected it. Resolving a preset needs a palette,
 * and a palette is a RENDERING decision this package does not get to make
 * (`canvas-render` owns it and depends on this package, not the other way
 * round). So the projection carries the colour as authored, on an extension
 * of ours, and a foreign reader paints the node however it paints an
 * un-styled one. Emitting a resolved `@ocif/rect` BESIDE that — better
 * interop, at the cost of a palette this layer would have to invent — is a
 * named follow-up rather than a thing this table can claim.
 */

/**
 * OCIF draws this as `@ocif/arrow`, which is a SHAPE with coordinates rather
 * than `@ocif/edge`, whose `start`/`end` must be node ids. The line still
 * reaches the same place; what changes is that it stops being a relation.
 *
 * This is the distinction the model does not currently make, and measuring
 * it is how it became visible.
 */
const AS_ARROW_SHAPE = {
  kind: 'degraded',
  to: "an @ocif/arrow's coordinates — the shape carries where the line runs and not what it was attached to, so a node end arrives as that node's centre",
} as const

/**
 * Per-end arrowheads collapse into one boolean. `@ocif/edge` says `directed`
 * for the whole edge; only `@ocif/arrow` has `startMarker`/`endMarker`, and
 * an edge that reaches a node is not an arrow.
 */
const AS_DIRECTED = {
  kind: 'degraded',
  to: "@ocif/edge's single `directed` boolean — the format has no per-end marker on a relation",
} as const

export const OCIF_PROJECTION: Readonly<Record<string, FieldProjection>> = {
  // ── Nodes ────────────────────────────────────────────────────────────
  'nodes[].id': NATIVE,
  // `position: [x, y]` and `size: [w, h]`. Real numbers, logical pixels —
  // so unlike JSON Canvas there is no rounding here. Slice 4's sub-pixel
  // geometry crosses intact, which is the first thing this table says that
  // the JSON Canvas one cannot.
  'nodes[].x': NATIVE,
  'nodes[].y': NATIVE,
  'nodes[].width': NATIVE,
  'nodes[].height': NATIVE,
  'nodes[].type': AS_SHAPE,
  'nodes[].color': EXTENSION,
  // Text is a resource (`text/markdown`), a file is a resource with a
  // `location`, a URL is a resource whose location is that URL.
  'nodes[].text': NATIVE,
  'nodes[].file': NATIVE,
  'nodes[].url': NATIVE,
  // Written `dropped` from the spec — an OCIF resource reference names a whole
  // resource and has no vocabulary for a fragment inside one. The projection
  // corrected it: what the FORMAT cannot state and what this PROJECTION cannot
  // carry are two different questions, and an extension of ours answers the
  // second. A foreign reader still loses it, which is what `extension` has
  // always meant here.
  'nodes[].subpath': EXTENSION,
  // A group's chrome. `@ocif/group` carries membership and nothing about how
  // the frame is painted, so these ride an extension of ours.
  'nodes[].label': EXTENSION,
  'nodes[].background': EXTENSION,
  'nodes[].backgroundStyle': EXTENSION,
  // OCIF nests canvases natively: a node may reference an OCIF document as a
  // resource (`application/ocif+json`). This is EXTENSION under JSON Canvas
  // and native here — the second thing OCIF states that the older format
  // cannot.
  'nodes[].embed.documentId': NATIVE,
  // Same correction as `subpath`: OCIF has no version concept, so a foreign
  // reader gets the document and not the point in its history — but the
  // projection carries it and its own round trip keeps it.
  'nodes[].embed.versionRef': EXTENSION,

  // ── Edges ────────────────────────────────────────────────────────────
  // An OCIF edge is a NODE carrying `@ocif/edge`, so an edge's identity is a
  // node id.
  'edges[].id': NATIVE,
  'edges[].from.node': NATIVE,
  'edges[].to.node': NATIVE,
  // Which side of the box the line attaches to. `@ocif/ports` names NODES
  // that act as connection points, which is a different idea: a port is a
  // thing, a side is a face of a thing.
  'edges[].from.side': EXTENSION,
  'edges[].to.side': EXTENSION,
  'edges[].from.end': AS_DIRECTED,
  'edges[].to.end': AS_DIRECTED,
  'edges[].color': EXTENSION,
  // OCIF has `rel` for what an edge MEANS and nothing for what it says on
  // the canvas. A label would be a separate node in OCIF's own vocabulary,
  // which is a structural change rather than a field, so it rides ours.
  'edges[].label': EXTENSION,
  // The points a person dragged. `@ocif/path` could hold them as a path
  // string, but that turns the relation into a drawing — the same trade an
  // arrow already makes.
  'edges[].bends[].x': EXTENSION,
  'edges[].bends[].y': EXTENSION,

  // ── Lines (ADR-0038 decision 2) ──────────────────────────────────────
  // A line is an `@ocif/arrow`: a SHAPE whose ends are coordinates. Reading
  // this block beside the edge block above is the clearest statement of what
  // the split bought — the two elements project onto the format's own two
  // extensions, and each one's ends are native to exactly the extension it
  // lands on. Under the old shape one element had to serve both, so its point
  // coordinates were `degraded` for every edge and its arrowheads were
  // `degraded` for every edge, whether or not that edge was ink.
  'lines[].id': NATIVE,
  // `@ocif/arrow`'s `start`/`end` ARE coordinates, so a free end crosses
  // exactly. This is a position that was `degraded` while ink was an edge.
  'lines[].from.point.x': NATIVE,
  'lines[].from.point.y': NATIVE,
  'lines[].to.point.x': NATIVE,
  'lines[].to.point.y': NATIVE,
  // And an arrow is the one element shape OCIF gives a PER-END marker, so
  // these stop collapsing into `directed`.
  'lines[].from.end': NATIVE,
  'lines[].to.end': NATIVE,
  'lines[].facets/*': NATIVE,
  // What a foreign reader does not get: that this end was attached to a box
  // rather than sitting at a coordinate that happens to be its centre.
  //
  // The two halves of that are different KINDS of loss, and the foreign-reader
  // comparison is what made the difference visible — both were written
  // `degraded` and one of them was wrong. `kind` really does degrade: the
  // field is still there after the trip, saying `point` where it said `node`.
  // `node` does not: the field is GONE, because the end it named became a
  // coordinate. A position that disappears is `extension`, whatever the
  // element around it did.
  'lines[].from.kind': AS_ARROW_SHAPE,
  'lines[].to.kind': AS_ARROW_SHAPE,
  'lines[].from.node': EXTENSION,
  'lines[].to.node': EXTENSION,
  'lines[].from.side': EXTENSION,
  'lines[].to.side': EXTENSION,
  'lines[].color': EXTENSION,
  'lines[].label': EXTENSION,
  'lines[].bends[].x': EXTENSION,
  'lines[].bends[].y': EXTENSION,

  // ── The annotation layer (ADR-0024) ──────────────────────────────────
  // OCIF has no comment concept, so these ride an extension of ours — but
  // the format REQUIRES a conforming reader to preserve it, so unlike JSON
  // Canvas's strict mode there is no mode in which the conversation is
  // dropped on the way through a foreign tool.
  'comments[].id': EXTENSION,
  'comments[].x': EXTENSION,
  'comments[].y': EXTENSION,
  'comments[].text': EXTENSION,
  'comments[].author': EXTENSION,
  'comments[].createdAt': EXTENSION,
  'comments[].targetNodeId': EXTENSION,
  'comments[].targetEdgeId': EXTENSION,
  'comments[].resolved': EXTENSION,

  // ── Facets (ADR-0013) ────────────────────────────────────────────────
  // OCIF's `data[]` IS this mechanism: a namespaced, schema'd, versioned
  // attribute group with a `type`, declared in the file's own `schemas`
  // array. A facet bucket is not something OCIF tolerates on a vendor key —
  // it is what the format is built out of.
  //
  // The fifth correction, and the only one where the TABLE was right and the
  // projection was not: a facet rode `@whiteboard/facets` until the
  // foreign-reader comparison asked what survives stripping our extensions,
  // and three positions declared `native` vanished. One `data` entry per
  // facet now, typed by the facet key.
  'facets/*': NATIVE,
  'nodes[].facets/*': NATIVE,
  'edges[].facets/*': NATIVE,
}
