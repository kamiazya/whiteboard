import { z } from 'zod'
import { extensionFacetsSchema } from './facets.js'
import { documentIdSchema, nodeIdSchema } from './ids.js'
import { integerSchema } from './integer.js'
import { okfActorSchema, okfTimestampSchema } from './trust.js'

// JSON Canvas 1.0 (https://jsoncanvas.org/spec/1.0/): color is either one of
// six numbered presets or a 6-digit hex string.
export const canvasColorSchema = z.union([
  z.enum(['1', '2', '3', '4', '5', '6']),
  z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a 6-digit hex color'),
])

export type CanvasColor = z.infer<typeof canvasColorSchema>

/**
 * What a node, an edge or the canvas may attach beyond its own fields: a
 * namespaced, versioned, schema'd payload bucket ([ADR-0013](../../../docs/contributing/adr/0013-facet-system.md)).
 *
 * It is an ordinary field of the model at each of the three sites. It used to
 * ride inside the JSON Canvas extension key, which is where it still travels
 * on the WIRE — packing it back there is `codec`'s projection, and
 * [ADR-0037](../../../docs/contributing/adr/0037-model-and-format.md) is why
 * the model no longer spells the format's key itself.
 */
const facetsFieldSchema = extensionFacetsSchema.optional().catch(undefined)

/**
 * The document a node shows inline — the one piece of content JSON Canvas 1.0
 * cannot express, and the reason its extension key exists at all.
 */
export const nodeEmbedSchema = z.object({
  documentId: documentIdSchema,
  versionRef: z.string().min(1).optional(),
})

export type NodeEmbed = z.infer<typeof nodeEmbedSchema>

/**
 * Geometry is a REAL number here, where JSON Canvas 1.0 specifies integer
 * pixels ([ADR-0037](../../../docs/contributing/adr/0037-model-and-format.md)).
 *
 * Ink is sub-pixel by nature — a pen reports fractions of a pixel, and a model
 * that rounds before it draws has thrown away what the pen measured. The
 * format's rounding belongs to the PROJECTION, and is codec's ledger's first
 * `degraded` entry.
 *
 * Finite, not merely numeric: `JSON.stringify(Infinity)` is `null` and a NaN
 * corner is not a corner, so widening to a float is not widening to any number
 * at all. Sizes still reject negatives; zero stays valid, because a node
 * collapsed on one axis is a layout concern rather than a parse error.
 *
 * Exported because every payload that ECHOES stored geometry has to accept
 * what the model stores. A read declaring `int` beside a model that holds a
 * fraction does not reject an input — it makes the tool answer with something
 * its own `outputSchema` refuses, which the MCP SDK raises as a failed call.
 */
export const nodePositionSchema = z.number().finite()
export const nodeSizeSchema = z.number().finite().nonnegative()

const sharedNodeFieldsSchema = z.object({
  id: nodeIdSchema,
  x: nodePositionSchema,
  y: nodePositionSchema,
  // Described on the stored shape for the reason the edge sides are: every
  // writer's schema derives from it, and a writer that names a size too
  // small for its text gets the size it named, so the description is where
  // it learns what leaving the size out buys.
  width: nodeSizeSchema.describe('Box width; text wraps at it. Omit it for the default.'),
  height: nodeSizeSchema.describe(
    'Box height. Omit it and a text box is made tall enough for its text; a named one too short for the text is refused with the height it needs.',
  ),
  color: canvasColorSchema.optional(),
  /**
   * The document this node shows inline. Independent of `facets` now: the
   * format's extension key made them two arms of a union, so a node could
   * carry an embed WITH facets or facets alone, and the model inherited a
   * choice the format's shape forced rather than one anything needed.
   */
  embed: nodeEmbedSchema.optional(),
  facets: facetsFieldSchema,
})

const textNodeSchema = sharedNodeFieldsSchema
  .extend({
    type: z.literal('text'),
    text: z.string(),
  })
  .strict()

const fileNodeSchema = sharedNodeFieldsSchema
  .extend({
    type: z.literal('file'),
    file: z.string(),
    subpath: z.string().startsWith('#').optional(),
  })
  .strict()

const linkNodeSchema = sharedNodeFieldsSchema
  .extend({
    type: z.literal('link'),
    url: z.url(),
  })
  .strict()

const groupNodeSchema = sharedNodeFieldsSchema
  .extend({
    type: z.literal('group'),
    label: z.string().optional(),
    background: z.string().optional(),
    backgroundStyle: z.enum(['cover', 'ratio', 'repeat']).optional(),
  })
  .strict()

export const spatialNodeSchema = z.discriminatedUnion('type', [
  textNodeSchema,
  fileNodeSchema,
  linkNodeSchema,
  groupNodeSchema,
])

export type SpatialNode = z.infer<typeof spatialNodeSchema>

/**
 * A hand-placed bend is a point somebody dragged, so the cap is about a
 * payload nobody meant rather than about the geometry: an edge with 64 bends
 * is a defect or an attack, not a drawing.
 */
const MAX_BENDS = 64

const canvasPointSchema = z.object({ x: nodePositionSchema, y: nodePositionSchema }).strict()

export const edgeSideSchema = z.enum(['top', 'right', 'bottom', 'left'])

export type EdgeSide = z.infer<typeof edgeSideSchema>

const arrowheadSchema = z
  .enum(['none', 'arrow'])
  .optional()
  .describe('The arrowhead drawn at this end.')

// Described on the stored shape because every writer's schema is derived from
// it: the description says what leaving a side out buys, since a router that
// honours a pinned side draws whatever the pin makes it draw.
const attachedSideSchema = edgeSideSchema
  .optional()
  .describe(
    'The side of the node to attach to. Omit it: the router picks the side that keeps the line clear of other boxes, and a named side is kept even through one.',
  )

/**
 * One end of an EDGE, which is a relation
 * ([ADR-0038](../../../docs/contributing/adr/0038-ocif-projection.md)
 * decision 2). An edge runs between two nodes, so an end names one — there is
 * no arm for a bare coordinate, and that absence is the decision.
 *
 * A plain object rather than a one-armed union: `kind` discriminates nothing
 * here, and carrying it would cost a key on every stored end and a `$defs`
 * entry in the tool table for a choice nobody makes. `lineEndSchema` below is
 * where the union lives, because that is where the choice is real.
 *
 * **Why the three flat fields are one object.** JSON Canvas 1.0 spells an end
 * as `fromNode` + `fromSide` + `fromEnd`, three parallel keys per end, because
 * a flat file format has no other way. The model said the same thing only
 * because it WAS the format
 * ([ADR-0037](../../../docs/contributing/adr/0037-model-and-format.md)); the
 * projection folds these back into the six flat keys on the way out, which is
 * what a projection is for.
 */
export const edgeEndSchema = z
  .object({
    node: nodeIdSchema.describe('The node this end attaches to.'),
    side: attachedSideSchema,
    end: arrowheadSchema,
  })
  .strict()

/**
 * Registered for the same reason `lineEndSchema` is, and measured again for
 * this shape: an edge end appears at four sites on `wb_canvas_edit` (`from`
 * and `to`, on `edge.add` and `edge.patch`), so four inlined copies of three
 * described fields is the most-repeated subschema the tool table has.
 *
 * Measured when ADR-0038 decision 2 narrowed it: leaving it unregistered took
 * the visible table 37,796 -> 38,317 bytes and its `parameters` count 273 ->
 * 285 — a REGRESSION on a strictly simpler schema, purely because the union
 * it replaced had been carrying a `$defs` entry and a plain object does not.
 * That is the trap this registry exists for: the saving belongs to the
 * repetition, not to the shape.
 */
z.globalRegistry.add(edgeEndSchema, { id: 'EdgeEnd' })

export type EdgeEnd = z.infer<typeof edgeEndSchema>

/**
 * One end of a LINE, which is ink: a node, or a bare point on the canvas.
 *
 * A CLOSED discriminated union, the shape `annotationAnchorSchema` already
 * uses, so every switch over an end stays exhaustive and a third kind (a line
 * ending on another line, say) arrives as an arm rather than as a fourth
 * exclusive field nobody enforces.
 *
 * **Why a union and not two optional fields.** An end is a node or a point,
 * never both and never neither, and `side` means nothing on a point — so the
 * flat shape would need a refinement to say what the type can say itself.
 * That is not only taste: `linePatchFieldsSchema` is `canvasLineSchema
 * .partial()`, and zod refuses `.partial()` over a refined object (the same
 * wall `canvasCommentDraftSchema` hit), so a refinement here would have to be
 * paid for with a second hand-written schema beside this one — the exact
 * drift this package exists to prevent. Measured again for this split: a
 * `discriminatedUnion` has no `.omit()`/`.partial()` AT ALL in zod v4, which
 * is why the two concepts are two collections rather than one union with a
 * `kind`.
 */
export const lineEndSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('node'),
      node: nodeIdSchema.describe('The node this end attaches to.'),
      side: attachedSideSchema,
      end: arrowheadSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('point'),
      point: canvasPointSchema.describe('Where this end sits, in canvas coordinates.'),
      end: arrowheadSchema,
    })
    .strict(),
])

/**
 * Named in zod's global registry so every JSON Schema emission puts it in
 * `$defs` and references it, instead of inlining the whole union at each use.
 *
 * This is a SIZE decision on the MCP tool table, and it is the only place it
 * can be made: the SDK converts a schema by calling
 * `schema['~standard'].jsonSchema.input({ target })` and passes no `reused`
 * option, so a caller cannot ask for `$ref` — but a registered `id` produces
 * one on that same path.
 *
 * Measured on the four sites `wb_canvas_edit` had for the old combined
 * endpoint (`from` and `to`, on `edge.add` and on `edge.patch`): 4,579 bytes
 * inlined against 1,786 referenced. That endpoint was the most-repeated
 * subschema this model had, and inlining it was 90% of the growth that took
 * the tool table over ADR-0031 §5's ceiling. A line's end inherits both the
 * repetition and the fix.
 *
 * `$defs`/`$ref` is ordinary draft-2020-12, which is the target MCP mandates
 * and the SDK sets, so a client that cannot resolve one is not conformant.
 */
z.globalRegistry.add(lineEndSchema, { id: 'LineEnd' })

export type LineEnd = z.infer<typeof lineEndSchema>

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

/** A line end on a node, spelled once so a fixture is not three keys of ceremony. */
export function nodeLineEnd(
  node: string,
  rest: { readonly side?: EdgeSide; readonly end?: 'none' | 'arrow' } = {},
): LineEnd {
  return {
    kind: 'node',
    node,
    ...(rest.side === undefined ? {} : { side: rest.side }),
    ...(rest.end === undefined ? {} : { end: rest.end }),
  }
}

/**
 * An EDGE is a relation: node to node, and what "what is connected to what"
 * means ([ADR-0038](../../../docs/contributing/adr/0038-ocif-projection.md)
 * decision 2). Ink that happens to run between two boxes is a
 * {@link canvasLineSchema}, not this.
 *
 * The distinction came from outside rather than from taste: OCIF's
 * `@ocif/edge` requires both ends to be node ids and offers `rel` so that
 * `(start, rel, end)` reads as a triple, while a line to a coordinate is
 * `@ocif/arrow`, a shape. Two designers reached the same place, and the
 * conflation was already costing something — ADR-0037 slice 3 reached the
 * free endpoint by widening this relation until it could hold a drawing.
 */
export const canvasEdgeSchema = z
  .object({
    id: nodeIdSchema,
    from: edgeEndSchema.describe('The node the relation starts at.'),
    to: edgeEndSchema.describe('The node the relation ends at.'),
    color: canvasColorSchema.optional(),
    label: z.string().optional(),
    /**
     * Points the edge is drawn THROUGH, in canvas coordinates, in order.
     *
     * A native field rather than a plugin facet, by ADR-0037 decision 3's
     * three answers: a person authors them by dragging a handle the core
     * editor draws, the renderer and the editor both read them, and the
     * ledger declares them `extension` — JSON Canvas 1.0 has no waypoint, so
     * a strict reader gets the computed route instead.
     *
     * They lived in `visual.path/v0` until this slice, and that was the
     * ADR's own worked example of the cost the old binding imposed: adding a
     * field to an edge cost a facet definition, an `EdgeRouter` contract and
     * the extraction of `packages/scene`. The seam stays — it was worth
     * building — and the concept comes home.
     *
     * Sub-pixel, like every other coordinate since this slice: the drag no
     * longer has to round before it writes.
     */
    bends: z
      .array(canvasPointSchema)
      .min(1)
      .max(MAX_BENDS)
      .optional()
      .describe(
        'Points to draw the line through, in order. Omit it: the route is computed around what is in the way.',
      ),
    /** Edge-target facets (ADR-0013 decision 5's edge slot). */
    facets: facetsFieldSchema,
  })
  .strict()

export type CanvasEdge = z.infer<typeof canvasEdgeSchema>

/**
 * A LINE is ink: it may end nowhere, it may attach to a node at either end,
 * and it asserts nothing about what is related to what
 * ([ADR-0038](../../../docs/contributing/adr/0038-ocif-projection.md)
 * decision 2).
 *
 * Everything an edge carries, it carries too — a colour, a label, bends, a
 * facet bucket — because the split is about what the element MEANS, not about
 * which decorations it is allowed. The one difference is the shape of an end,
 * and that is the whole difference.
 *
 * Two ends on nodes is legal here, and is the expressiveness the split buys:
 * a decorative stroke between two boxes is not a claim that they are
 * connected. It is also where freehand lands rather than growing a third
 * concept.
 */
export const canvasLineSchema = z
  .object({
    id: nodeIdSchema,
    from: lineEndSchema.describe(
      'Where the line starts: on a node (`{kind:"node",node}`) or at a free point on the canvas (`{kind:"point",point}`).',
    ),
    to: lineEndSchema.describe(
      'Where the line ends: on a node (`{kind:"node",node}`) or at a free point on the canvas (`{kind:"point",point}`).',
    ),
    color: canvasColorSchema.optional(),
    label: z.string().optional(),
    bends: z
      .array(canvasPointSchema)
      .min(1)
      .max(MAX_BENDS)
      .optional()
      .describe(
        'Points to draw the line through, in order. Omit it: the route is computed around what is in the way.',
      ),
    facets: facetsFieldSchema,
  })
  .strict()

export type CanvasLine = z.infer<typeof canvasLineSchema>

function findDuplicateId(ids: string[]): string | undefined {
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) return id
    seen.add(id)
  }
  return undefined
}

/**
 * How an edge gets from one endpoint to the other once the router has decided
 * it must step around something.
 *
 * Declared on its own rather than inline, because the same choice is meant to
 * be overridable per edge — that override reuses this type, never restates
 * it. Stored as the `visual.edges/v0` facet, never as a field of its own.
 *
 * `straight` is the default and the only shape JSON Canvas itself implies:
 * direct segments, bending only to clear an obstacle.
 */
export const edgeRoutingStyleSchema = z.enum(['straight', 'orthogonal', 'curved'])

export type EdgeRoutingStyle = z.infer<typeof edgeRoutingStyleSchema>

/**
 * Line jumps draw a small arc where one edge crosses another, so crossing
 * lines stay readable. The same enum serves the canvas and a per-edge
 * override alike.
 */
export const lineJumpsSchema = z.enum(['none', 'arc'])

export type LineJumps = z.infer<typeof lineJumpsSchema>

/**
 * The RESOLVED answer to "how are these edges drawn" — what a resolver hands
 * the layout, never a stored shape (the stored shape is the facet).
 */
export const edgeRoutingSchema = z.object({
  style: edgeRoutingStyleSchema.optional(),
  lineJumps: lineJumpsSchema.optional(),
})

/**
 * A comment pinned to the canvas — the annotation layer (ADR-0024).
 *
 * `x`/`y` is the ANCHOR: the point the comment is about, in JSON Canvas
 * integer canvas coordinates. It is deliberately not a bounding box — where
 * the comment's bubble draws is a renderer decision (floating near the
 * anchor), never stored. `targetNodeId` narrows the anchor to "about this
 * node"; a renderer follows the node's current position and falls back to
 * the anchor point when the node is gone. A dangling `targetNodeId` is
 * VALID: a comment may outlive its subject, and the annotation layer must
 * never make the document unreadable.
 *
 * `author` is an OKF actor string (`human:<id>` / `process:<id>`, ADR-0016)
 * so the `human:` prefix keeps its trust meaning across layers; `createdAt`
 * is an OKF timestamp. Both optional: identity is a keeper concern this
 * model does not solve.
 */
const canvasCommentFieldsSchema = z.object({
  id: nodeIdSchema,
  x: integerSchema,
  y: integerSchema,
  text: z.string().min(1),
  author: okfActorSchema.optional(),
  createdAt: okfTimestampSchema.optional(),
  targetNodeId: nodeIdSchema.optional(),
  /**
   * The edge the comment is about, the way `targetNodeId` names a node: a
   * renderer keeps the pin on the edge's routed path and falls back to the
   * anchor point when the edge is gone. Never both — enforced below,
   * because the thread a comment becomes carries both onto one spatial
   * anchor, and `annotationAnchorSchema` refuses an anchor naming two
   * objects. Accepted here and refused there, the comment was written and
   * then silently dropped by every reader.
   */
  targetEdgeId: nodeIdSchema.optional(),
  resolved: z.boolean().optional(),
})

const namesOneTarget = (comment: { targetNodeId?: string; targetEdgeId?: string }): boolean =>
  comment.targetNodeId === undefined || comment.targetEdgeId === undefined
const ONE_TARGET = { message: 'a comment is about a node or an edge, not both' }

export const canvasCommentSchema = canvasCommentFieldsSchema.refine(namesOneTarget, ONE_TARGET)

export type CanvasComment = z.infer<typeof canvasCommentSchema>

/**
 * A comment as a caller DRAFTS it: the id may be minted and the anchor
 * point derived from the node it names, so both are optional here. Declared
 * beside the stored shape because zod refuses `.partial()` over a refined
 * object, and the one-target rule has to hold for a draft too — a draft that
 * escaped it would be stored, become a thread naming two objects, and vanish.
 */
export const canvasCommentDraftSchema = canvasCommentFieldsSchema
  .partial({ id: true, x: true, y: true })
  .refine(namesOneTarget, ONE_TARGET)

export type CanvasCommentDraft = z.infer<typeof canvasCommentDraftSchema>

export const spatialCanvasSchema = z
  .object({
    // JSON Canvas 1.0 declares both top-level arrays optional; a bare `{}`
    // is a valid (empty) canvas.
    // Both arrays default to empty: an empty board is a board.
    nodes: z.array(spatialNodeSchema).default([]),
    edges: z.array(canvasEdgeSchema).default([]),
    /**
     * The ink an edge is not (ADR-0038 decision 2).
     *
     * OPTIONAL, like `comments` and unlike `nodes`/`edges`, and the reason is
     * measured rather than aesthetic: `.default([])` makes the field required
     * on the OUTPUT type, and this repo builds 925 canvas literals across 295
     * files. Adding `lines: []` to every one of them would be the largest part
     * of this diff by far, all of it noise, on a field almost every board
     * leaves empty — and a diff a reviewer cannot read is a diff nobody
     * reviews. An absent `lines` and an empty one say the same thing, which is
     * the canonicalisation the codec already makes for an empty extension
     * object.
     */
    lines: z.array(canvasLineSchema).optional(),
    /**
     * The comment annotation layer (ADR-0024).
     *
     * NOTE the STORAGE shape differs from this one: the Loro bridge keeps each
     * comment under its own key in a dedicated plane (per-comment CRDT merge,
     * so two peers commenting concurrently both survive) and projects them
     * back here — see loro-adapter's `readSpatialCanvas`.
     *
     * `.catch(undefined)` per BUCKET rather than over the canvas: a malformed
     * comment must cost the comments, not the facets beside them, and neither
     * may cost the board.
     */
    comments: z.array(canvasCommentSchema).optional().catch(undefined),
    /** Canvas-target facets (ADR-0013 decision 5). */
    facets: facetsFieldSchema,
  })
  /**
   * Strict at all three sites, which the format's own schema is NOT and must
   * not be — a JSON Canvas document another tool wrote may carry vendor keys,
   * and refusing it would be wrong. This is the INTERNAL model: a key it does
   * not name is a defect, and a plain `z.object` strips one in silence. That
   * silence is what ADR-0037's migration had to survive, since every reader
   * that still spelled the format's extension key would otherwise have parsed
   * cleanly and lost what it was reading.
   */
  .strict()
  .superRefine((value, ctx) => {
    const duplicateNodeId = findDuplicateId(value.nodes.map((node) => node.id))
    if (duplicateNodeId !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: `duplicate node id "${duplicateNodeId}"`,
        path: ['nodes'],
      })
    }

    // ACROSS both collections, not per collection. An anchor names an element
    // id — a comment's `targetEdgeId`, a proposal's change — so two elements
    // answering to one id makes an anchor ambiguous rather than merely untidy.
    const duplicateElementId = findDuplicateId([
      ...value.edges.map((edge) => edge.id),
      ...(value.lines ?? []).map((line) => line.id),
    ])
    if (duplicateElementId !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: `duplicate edge or line id "${duplicateElementId}"`,
        path: ['edges'],
      })
    }

    const nodeIds = new Set(value.nodes.map((node) => node.id))
    const checkEnds = (
      elements: readonly { readonly id: string; readonly from: unknown; readonly to: unknown }[],
      collection: 'edges' | 'lines',
    ) => {
      elements.forEach((element, index) => {
        // Only a NODE end can dangle. A point end names nothing to be missing,
        // which is the whole of what a line's free arm is.
        for (const side of ['from', 'to'] as const) {
          const node = endNode(element[side] as LineEnd | EdgeEnd)
          if (node === undefined || nodeIds.has(node)) continue
          ctx.addIssue({
            code: 'custom',
            message: `${collection === 'edges' ? 'edge' : 'line'} "${element.id}" references nonexistent ${side} node "${node}"`,
            path: [collection, index, side, 'node'],
          })
        }
      })
    }
    checkEnds(value.edges, 'edges')
    checkEnds(value.lines ?? [], 'lines')
  })

export type SpatialCanvas = z.infer<typeof spatialCanvasSchema>
