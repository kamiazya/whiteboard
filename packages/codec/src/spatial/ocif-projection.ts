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
 * different shape, which is what `degraded` is for.
 */
const AS_SHAPE = {
  kind: 'degraded',
  to: "the node's resource and extensions — OCIF has no node type field, so what a node IS comes from what it shows and what it carries",
} as const

/**
 * A JSON Canvas colour is a PRESET index ("1".."6") or a hex value, and a
 * preset means "whatever this theme paints that role". OCIF's shape
 * extensions take concrete `fillColor`/`strokeColor`, so a preset has to be
 * resolved on the way out and arrives as the colour it happened to resolve
 * to — the role is gone.
 */
const RESOLVED_COLOUR = {
  kind: 'degraded',
  to: 'a concrete fillColor/strokeColor on the shape extension; a preset index loses the theme role it named',
} as const

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
  to: 'an @ocif/arrow shape — OCIF edges must run between two node ids, so a line to a bare point is a drawing rather than a relation',
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
  'nodes[].color': RESOLVED_COLOUR,
  // Text is a resource (`text/markdown`), a file is a resource with a
  // `location`, a URL is a resource whose location is that URL.
  'nodes[].text': NATIVE,
  'nodes[].file': NATIVE,
  'nodes[].url': NATIVE,
  // A fragment inside the referenced file. OCIF's resource reference names
  // the whole resource and has no notion of a part of one.
  'nodes[].subpath': {
    kind: 'dropped',
    why: 'an OCIF resource reference names a whole resource; the format has no vocabulary for a fragment inside one',
  },
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
  'nodes[].embed.versionRef': {
    kind: 'dropped',
    why: 'OCIF has no version concept; a reference names a resource, not a point in its history',
  },

  // ── Edges ────────────────────────────────────────────────────────────
  // An OCIF edge is a NODE carrying `@ocif/edge`, so an edge's identity is a
  // node id.
  'edges[].id': NATIVE,
  'edges[].from.kind': AS_SHAPE,
  'edges[].to.kind': AS_SHAPE,
  'edges[].from.node': NATIVE,
  'edges[].to.node': NATIVE,
  'edges[].from.point.x': AS_ARROW_SHAPE,
  'edges[].from.point.y': AS_ARROW_SHAPE,
  'edges[].to.point.x': AS_ARROW_SHAPE,
  'edges[].to.point.y': AS_ARROW_SHAPE,
  // Which side of the box the line attaches to. `@ocif/ports` names NODES
  // that act as connection points, which is a different idea: a port is a
  // thing, a side is a face of a thing.
  'edges[].from.side': EXTENSION,
  'edges[].to.side': EXTENSION,
  'edges[].from.end': AS_DIRECTED,
  'edges[].to.end': AS_DIRECTED,
  'edges[].color': RESOLVED_COLOUR,
  // OCIF has `rel` for what an edge MEANS and nothing for what it says on
  // the canvas. A label would be a separate node in OCIF's own vocabulary,
  // which is a structural change rather than a field, so it rides ours.
  'edges[].label': EXTENSION,
  // The points a person dragged. `@ocif/path` could hold them as a path
  // string, but that turns the relation into a drawing — the same trade the
  // free endpoint makes.
  'edges[].bends[].x': EXTENSION,
  'edges[].bends[].y': EXTENSION,

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
  'facets/*': NATIVE,
  'nodes[].facets/*': NATIVE,
  'edges[].facets/*': NATIVE,
}
