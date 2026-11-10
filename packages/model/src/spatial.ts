import type { EdgeEnd, EdgeSide, LineEnd, SpatialNode } from './generated/spatial.zod.js'

export { findDuplicateId } from './contract-checks.js'
// Everything a spatial canvas is made of is generated from
// `contracts/model/spatial.schema.json` and keeps the name it had here. What
// the contract cannot state stays in `contract-checks.ts` (the refinements,
// written once for each language) and in the hand-written schemas it imports
// (ids, facets, tags, a node's resource).
//
// The colour is JSON Canvas 1.0's (https://jsoncanvas.org/spec/1.0/): a
// numbered preset or a 6-digit hex string.
export {
  type CanvasColor,
  type CanvasComment,
  type CanvasEdge,
  type CanvasLine,
  canvasColorSchema,
  canvasCommentSchema,
  canvasEdgeSchema,
  canvasLineSchema,
  type EdgeEnd,
  type EdgeRouting,
  type EdgeRoutingStyle,
  type EdgeSide,
  edgeEndSchema,
  edgeRoutingSchema,
  edgeRoutingStyleSchema,
  edgeSideSchema,
  type LineEnd,
  type LineJumps,
  lineEndSchema,
  lineJumpsSchema,
  type NodeEmbed,
  nodePositionSchema,
  nodeSizeSchema,
  type SharedNodeFields,
  type SpatialCanvas,
  type SpatialNode,
  sharedNodeFieldsSchema,
  spatialCanvasSchema,
  spatialNodeSchema,
} from './generated/spatial.zod.js'

// Geometry is a REAL number, where JSON Canvas 1.0 specifies integer pixels
// ([ADR-0037](../../../docs/contributing/adr/0037-model-and-format.md)).
//
// Ink is sub-pixel by nature — a pen reports fractions of a pixel, and a model
// that rounds before it draws has thrown away what the pen measured. The
// format's rounding belongs to the PROJECTION, and is codec's ledger's first
// `degraded` entry.
//
// Finite, not merely numeric: `JSON.stringify(Infinity)` is `null` and a NaN
// corner is not a corner. Zod 4's `z.number()` already refuses both, which is
// why the contract says only `number`. Sizes reject negatives; zero stays
// valid, because a node collapsed on one axis is a layout concern rather than
// a parse error.
//
// `nodePositionSchema` and `nodeSizeSchema` are exported because every payload
// that ECHOES stored geometry has to accept what the model stores: a read
// declaring `int` beside a model that holds a fraction makes the tool answer
// with something its own `outputSchema` refuses.
//
// `sharedNodeFieldsSchema` is what every node has, exported because
// `spatialNodeSchema` is REFINED and zod v4 refuses `.partial()` over a
// refined object: a writer deriving an optional-geometry draft derives it from
// this, the same object the stored schema extends, so the two cannot disagree
// about a field's type.
//
// A node is a BOX that may SHOW something
// ([ADR-0038](../../../docs/contributing/adr/0038-ocif-projection.md)
// decision 3): the kind is DERIVED from its `resource` (`nodeKind`), never
// stored. Absent `resource` means the node shows nothing, which is a FRAME.
// The frame's fields belong to the frame, so a node that shows a resource may
// not carry them.

/**
 * A hand-placed bend is a point somebody dragged, so the cap is about a
 * payload nobody meant rather than about the geometry: an edge with 64 bends
 * is a defect or an attack, not a drawing.
 *
 * Exported because every writer has to stay inside it: a record over the cap
 * fails validation on read, and a reader that skips it drops the whole
 * element. A freehand stroke stores its turns as bends too, so the editor's
 * stroke budget derives from this rather than from a number of its own. The
 * contract's `Bends.maxItems` is the schema's copy; `spatial.test.ts` holds the
 * two equal. Published as `maxItems` in `docs/reference/x-whiteboard.schema.json`.
 */
export const MAX_BENDS = 64

// The ends of an EDGE and of a LINE
// ([ADR-0038](../../../docs/contributing/adr/0038-ocif-projection.md)
// decision 2). An edge runs between two nodes, so its end names one; a line is
// ink, so its end is a CLOSED discriminated union of a node and a bare point,
// the shape `annotationAnchorSchema` already uses.
//
// A union and not two optional fields because `linePatchFieldsSchema` is
// `canvasLineSchema.partial()` and zod refuses `.partial()` over a refined
// object, so a refinement would be paid for with a second hand-written schema.
//
// Both are REGISTERED in zod's global registry (`EdgeEnd`, `LineEnd`) so every
// JSON Schema emission puts them in `$defs` and references them: the SDK
// converts a schema without a `reused` option, and a registered `id` is the
// only lever. Measured on `wb_canvas_edit`'s four endpoint sites: 4,579 bytes
// inlined against 1,786 referenced.

/**
 * The node an end attaches to, or `undefined` when it is a free point.
 *
 * Most readers of a line end want exactly this — "is this line on node X",
 * "look the box up" — and writing the narrowing at each of them is how one of
 * them comes to forget the point arm. A free end answering `undefined` is the
 * same shape those readers already handle for a dangling reference.
 *
 * It takes an EDGE end too, where the answer is always the node: a reader
 * walking both collections should not have to know which it is holding.
 */
export function endNode(end: LineEnd | EdgeEnd): string | undefined {
  if (!('kind' in end)) return end.node
  return end.kind === 'node' ? end.node : undefined
}

/**
 * The nodes an edge or line names — one, two, or none, since a free end names
 * nothing.
 *
 * The shape every existence check wants: "which of this element's ends refer
 * to something that has to be there". Written as a list rather than a pair so
 * a caller loops rather than branching, which is what kept the free arm from
 * having to be special-cased at each of them.
 */
export function endNodes(element: {
  readonly from: LineEnd | EdgeEnd
  readonly to: LineEnd | EdgeEnd
}): readonly string[] {
  return [endNode(element.from), endNode(element.to)].filter(
    (node): node is string => node !== undefined,
  )
}

/**
 * Whether an end sits on one of these nodes. A FREE end sits on none of them,
 * which is what every caller means: the sets here are "the nodes in this
 * fragment", "the nodes being deleted", "the members of this group", and a
 * point belongs to no such collection.
 *
 * A helper rather than `ids.has(endNode(end) ?? '')` at twenty call sites:
 * the sentinel reads as a trick, and one reader eventually writes `?? ''`
 * somewhere an empty id IS meaningful.
 */
export function endIn(end: LineEnd | EdgeEnd, ids: ReadonlySet<string>): boolean {
  const node = endNode(end)
  return node !== undefined && ids.has(node)
}

/**
 * Whether an edge or line has an end on one of these nodes — the element a
 * node's removal takes with it, since an end naming a node that is gone is
 * what `spatialCanvasSchema` refuses. A line with two free ends sits on no
 * node and is never swept up by this (ADR-0038 decision 2).
 */
export function anchoredOnAny(
  element: { readonly from: LineEnd | EdgeEnd; readonly to: LineEnd | EdgeEnd },
  ids: ReadonlySet<string>,
): boolean {
  return endIn(element.from, ids) || endIn(element.to, ids)
}

/**
 * The node an end sits on, looked up in a map keyed by node id.
 *
 * The companion `endIn` is to a Set: both exist so a caller never writes
 * `byId.get(endNode(end) ?? '')`. The sentinel reads as a trick, and one
 * reader eventually writes it where an empty id IS a key — and it is one
 * character away from `byId.get('')` answering something.
 */
export function nodeAtEnd<T>(end: LineEnd | EdgeEnd, byId: ReadonlyMap<string, T>): T | undefined {
  const node = endNode(end)
  return node === undefined ? undefined : byId.get(node)
}

/**
 * Whether both ends sit on the SAME node — a self-loop.
 *
 * Not `endNode(from) === endNode(to)`, which is what a reader reaches for and
 * which answers TRUE for two free ends: they are both `undefined`, and a line
 * drawn between two bare points is the opposite of a self-loop. The comparison
 * is written once here so that trap is sprung once.
 */
export function isSelfLoop(element: {
  readonly from: LineEnd | EdgeEnd
  readonly to: LineEnd | EdgeEnd
}): boolean {
  const from = endNode(element.from)
  return from !== undefined && from === endNode(element.to)
}

/**
 * The side an end is pinned to, or `undefined` — which a free end always is,
 * since a point has no sides to choose between.
 *
 * The companion to `endNode`, and here for the same reason: a router asking
 * "was a side named" wants one answer, and writing the narrowing at every such
 * site is how one of them comes to treat a point end as a node whose side
 * nobody set.
 */
export function endSide(end: LineEnd | EdgeEnd): EdgeSide | undefined {
  if (!('kind' in end)) return end.side
  return end.kind === 'node' ? end.side : undefined
}

type NodeBox = Pick<SpatialNode, 'x' | 'y' | 'width' | 'height'>

/**
 * Whether a frame's box holds a node: the node's whole box lies inside it,
 * edges inclusive, so a node flush with the frame's border is a member.
 * Membership is geometric in this model — no stored list says who is in a
 * frame — and this is the one place that says what "in" means. The frame is a
 * box rather than a node because a gesture asks about the box a frame WILL
 * have, not the one it has.
 *
 * A frame holds itself by this rule; a caller that wants the members alone
 * uses `membersOf`, which drops it by id.
 */
export function frameHolds(frame: NodeBox, node: NodeBox): boolean {
  return (
    node.x >= frame.x &&
    node.y >= frame.y &&
    node.x + node.width <= frame.x + frame.width &&
    node.y + node.height <= frame.y + frame.height
  )
}

/** The nodes a frame holds, the frame itself excluded, in the order given. */
export function membersOf(
  nodes: readonly SpatialNode[],
  frame: SpatialNode,
): readonly SpatialNode[] {
  return nodes.filter((node) => node.id !== frame.id && frameHolds(frame, node))
}
