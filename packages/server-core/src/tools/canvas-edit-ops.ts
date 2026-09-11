/**
 * What `wb_canvas_edit` accepts and answers: the op union and the input and
 * output schemas, in one place a model reads and the tool executes.
 */
import {
  annotationIdSchema,
  canvasCommentDraftSchema,
  canvasEdgeSchema,
  documentIdSchema,
  type ExtensionFacets,
  edgePatchFieldsSchema,
  extensionFacetsSchema,
  type NodeEmbed,
  nodeIdSchema,
  nodePatchFieldsSchema,
  nonnegativeIntegerSchema,
  proposalSchema,
  spatialNodeSchema,
  workspaceIdSchema,
} from '@kamiazya/whiteboard-model'
import { z } from 'zod'
import { canvasSnapshotSchema } from './canvas-snapshot.js'

// Derived from the stored node schemas rather than restated beside them, so
// a field added to a node type reaches this tool's input for free. Only the
// id and the four geometry fields become optional; `type` stays required
// because it is the discriminator, and the per-type content fields stay
// required because there is no sensible default for a link with no url.
const GEOMETRY_OPTIONAL = { x: true, y: true, width: true, height: true } as const
const DRAFT_OPTIONAL = { id: true, ...GEOMETRY_OPTIONAL } as const
const [textNode, fileNode, linkNode, groupNode] = spatialNodeSchema.options
/**
 * The model's two extension fields are omitted from the derived options and
 * reached through `WRITE_EXTENSION` below instead.
 *
 * Deriving from the stored schemas means a field added to a node type arrives
 * here for free — which is the point, and wrong for exactly these two: the
 * tool already publishes a way to write them, and a second one is two
 * spellings of one thing on a table a model reads every turn. Measured when
 * ADR-0033 moved them onto the node: 14 new parameters across the four node
 * types, every one of them undescribed.
 */
const STORED_EXTENSION_FIELDS = { embed: true, facets: true } as const
const textOption = textNode.omit(STORED_EXTENSION_FIELDS)
const fileOption = fileNode.omit(STORED_EXTENSION_FIELDS)
const linkOption = linkNode.omit(STORED_EXTENSION_FIELDS)
const groupOption = groupNode.omit(STORED_EXTENSION_FIELDS)

/**
 * The node extension as a WRITER declares it: one flat object instead of
 * the stored two-variant union, narrowed to the stored shape on parse.
 *
 * Two reasons, one of them measured. The stored schema `.catch`es an
 * unrecognised extension so a canvas stays readable, which on the write
 * side would silently DROP a broken embed a caller just sent; here a
 * `kind: "embed"` with no document is refused by name. And the stored
 * union is emitted inline into the tool's input once per node type per op
 * — eight times, 487 bytes each — where this shape is 290, on a table a
 * model reads on every turn.
 */
const nodeExtensionWriteSchema = z
  .object({
    kind: z.literal('embed').optional(),
    documentId: documentIdSchema.optional(),
    versionRef: z.string().min(1).optional(),
    facets: extensionFacetsSchema.optional(),
  })
  .strict()
  .refine((value) => (value.kind === 'embed') === (value.documentId !== undefined), {
    message: 'an embed names the document it embeds: kind "embed" and documentId go together',
  })
  /**
   * Out comes the MODEL's two fields, not the format's union arm.
   *
   * The tool's INPUT key stays `x-whiteboard` — it is published in
   * `tools/list`, a model reads it every turn, and moving it is a tool-surface
   * change with its own gate (ADR-0031). What ADR-0033 changed is the far
   * side: a node carries `embed` and `facets` independently now, and the
   * transform is where the union arm becomes them.
   */
  .transform((value): { embed?: NodeEmbed; facets?: ExtensionFacets } => ({
    ...(value.kind === 'embed' &&
      value.documentId !== undefined && {
        embed: {
          documentId: value.documentId,
          ...(value.versionRef === undefined ? {} : { versionRef: value.versionRef }),
        },
      }),
    ...(value.facets === undefined ? {} : { facets: value.facets }),
  }))
const WRITE_EXTENSION = { 'x-whiteboard': nodeExtensionWriteSchema.optional() } as const

const nodeDraftSchema = z.discriminatedUnion('type', [
  textOption.partial(DRAFT_OPTIONAL).extend(WRITE_EXTENSION),
  fileOption.partial(DRAFT_OPTIONAL).extend(WRITE_EXTENSION),
  linkOption.partial(DRAFT_OPTIONAL).extend(WRITE_EXTENSION),
  groupOption.partial(DRAFT_OPTIONAL).extend(WRITE_EXTENSION),
])

const edgeDraftSchema = canvasEdgeSchema.partial({ id: true })

/**
 * A key of the draft, written beside `op` instead of inside it, is told
 * where it belongs. `node.patch`, `node.remove` and `node.lock` all take
 * `id` at the op level and `node.add` takes it inside `node`, so a model
 * generalises from the ops it just used and loses the WHOLE batch: one op
 * failing validation refuses the call, and `Unrecognized key: "id"` names
 * the key without naming the one thing needed to repair it. Measured in
 * round 11 of the eval lane.
 *
 * Only a key the draft actually has is redirected. A typo has nowhere to
 * point, and sending it inside `node` would be a wrong answer stated as
 * confidently as a right one.
 */
const keysOf = (schema: { shape: Record<string, unknown> }) => Object.keys(schema.shape)
const NODE_DRAFT_KEYS = new Set(nodeDraftSchema.options.flatMap(keysOf))
const EDGE_DRAFT_KEYS = new Set(keysOf(edgeDraftSchema))
const quoted = (keys: readonly string[]) => keys.map((key) => `"${key}"`).join(', ')
const draftKeysBelongInside = (field: 'node' | 'edge', draftKeys: ReadonlySet<string>) => ({
  error: (issue: { code: string; keys?: readonly string[] }) =>
    issue.code === 'unrecognized_keys' && (issue.keys ?? []).some((key) => draftKeys.has(key))
      ? `Unrecognized key(s): ${quoted(issue.keys ?? [])} — the new ${field}'s own fields go inside \`${field}\`, not beside \`op\`.`
      : undefined,
})

/**
 * One step of a batch. The verbs are the ones the retired single-purpose
 * tools carried, so nothing an agent could do before is missing here — plus
 * `node.remove` / `edge.remove`, which had no tool at all: the only way to
 * delete anything used to be a whole-document replace.
 */
/**
 * Where one id goes, a SELECTOR may go instead: every node inside a group,
 * or every node on the canvas. Measured before it existed: "colour every box
 * inside the Clients group" and "lock every item on the roadmap" each cost a
 * read the errand did not need — the snapshot was there only to learn the
 * ids the edit would then name one by one. Exactly one of the three.
 */
const NODE_TARGET = {
  id: nodeIdSchema.optional(),
  within: nodeIdSchema.optional().describe('Instead of id: every node inside this group.'),
  all: z.literal(true).optional().describe('Instead of id: every node on the canvas.'),
} as const
const EDGE_TARGET = {
  id: nodeIdSchema.optional(),
  within: nodeIdSchema
    .optional()
    .describe('Instead of id: every edge with both ends inside this group.'),
  all: z.literal(true).optional().describe('Instead of id: every edge on the canvas.'),
} as const
export type Target = { id?: string; within?: string; all?: true }
const exactlyOneTarget = {
  check: (value: Target) =>
    [value.id, value.within, value.all].filter((field) => field !== undefined).length === 1,
  message: 'name exactly one of id, within and all',
}

const canvasOpSchema = z.discriminatedUnion('op', [
  z
    .object(
      {
        op: z.literal('node.add'),
        node: nodeDraftSchema,
        within: nodeIdSchema
          .nullable()
          .optional()
          .describe(
            'A group on the canvas, or added earlier in this batch, to place the node inside; it grows to fit, and one added in this batch with no position is placed around what goes in it. To wrap boxes that already exist in a new group, add the group and then region.set.',
          ),
      },
      draftKeysBelongInside('node', NODE_DRAFT_KEYS),
    )
    .strict(),
  z
    .object({ op: z.literal('node.patch'), ...NODE_TARGET, patch: nodePatchFieldsSchema })
    .strict()
    .refine(exactlyOneTarget.check, { message: exactlyOneTarget.message }),
  /**
   * A line-range splice of a text node's body, `[startLine, endLine]`
   * inclusive and 0-indexed. `node.patch`'s `text` replaces the whole body;
   * this replaces part of it, so a caller editing one line of a long note
   * sends that line. Retired `wb_body_patch` into this tool: as an op it
   * batches with everything else, and it falls under the propose-by-default
   * rule that tool had no mode for.
   */
  z
    .object({
      op: z.literal('node.splice'),
      id: nodeIdSchema,
      startLine: nonnegativeIntegerSchema,
      endLine: nonnegativeIntegerSchema,
      replacement: z.string(),
    })
    .strict()
    .refine((value) => value.startLine <= value.endLine, {
      message: 'startLine must be <= endLine',
    }),
  z
    .object({ op: z.literal('node.remove'), ...NODE_TARGET })
    .strict()
    .refine(exactlyOneTarget.check, { message: exactlyOneTarget.message }),
  z
    .object(
      { op: z.literal('edge.add'), edge: edgeDraftSchema },
      draftKeysBelongInside('edge', EDGE_DRAFT_KEYS),
    )
    .strict(),
  z
    .object({ op: z.literal('edge.patch'), id: nodeIdSchema, patch: edgePatchFieldsSchema })
    .strict(),
  z
    .object({ op: z.literal('edge.remove'), ...EDGE_TARGET })
    .strict()
    .refine(exactlyOneTarget.check, { message: exactlyOneTarget.message }),
  z
    .object({ op: z.literal('node.lock'), ...NODE_TARGET, locked: z.boolean() })
    .strict()
    .refine(exactlyOneTarget.check, { message: exactlyOneTarget.message }),
  z
    .object({ op: z.literal('edge.lock'), ...EDGE_TARGET, locked: z.boolean() })
    .strict()
    .refine(exactlyOneTarget.check, { message: exactlyOneTarget.message }),
  z
    .object({
      op: z.literal('tidy'),
      scope: z.array(nodeIdSchema).min(1).optional(),
      within: nodeIdSchema.optional().describe('Instead of scope: every node inside this group.'),
    })
    .strict()
    .refine((value) => value.scope === undefined || value.within === undefined, {
      message: 'scope and within are alternatives; pass one',
    }),
  /**
   * The annotation layer (ADR-0024). A draft may omit the id (minted) and
   * the anchor point — a comment about a NODE names `targetNodeId` and the
   * server anchors it at that node's top-right corner. `createdAt` defaults
   * to now, stamped by the server so the record orders without trusting
   * every caller's clock format.
   */
  z
    .object({
      op: z.literal('comment.add'),
      comment: canvasCommentDraftSchema,
    })
    .strict(),
  /**
   * Resolution keeps the record in the document (the conversation is the
   * point); `resolved: false` reopens. There is deliberately NO remove op:
   * resolving is the only way to close a comment, for a person in the
   * editor and for an agent alike (ADR-0025 decision 2) — a verb one side
   * had and the other did not would let an agent erase feedback a person
   * could only close.
   */
  z
    .object({
      op: z.literal('comment.resolve'),
      id: nodeIdSchema,
      resolved: z.boolean().optional(),
    })
    .strict(),
  /**
   * "This group contains exactly these." The ONE declarative op, and so the
   * only one that deletes something it was not told about.
   *
   * It names MEMBERS by id and nothing else. The shape used to carry a full
   * node declaration per member — the node union a second time, a third of
   * this tool's bytes — and the lane showed what a model did with that:
   * wrote x/y/width/height for every box, the ones already there included.
   * Creating a member is `node.add` with `within`.
   *
   * Scope is STRICT containment in `within`'s stored box. That rule is what
   * makes the boundary safe rather than a judgement call: a node straddling
   * the edge — a human mid-drag — is not enclosed, so it is out of scope and
   * survives. A listed node that is elsewhere is moved in and placed — except
   * into a group this batch added without a position, which goes around
   * its members instead.
   */
  z
    .object({
      op: z.literal('region.set'),
      within: nodeIdSchema,
      nodes: z
        .array(nodeIdSchema)
        .describe(
          'Every node the group contains, by id: one inside it that is not listed is removed, one listed that is elsewhere is moved in — unless the group was added in this batch with no position, which is placed around them where they sit. Create a new member with node.add and within.',
        ),
      edges: z
        .array(nodeIdSchema)
        .optional()
        .describe('Edges to keep among the members; omitted keeps every edge whose ends survive.'),
    })
    .strict(),
])

/**
 * 200 is a ceiling on one request, not on a board: a batch past this size is
 * almost always a model looping, and a rejected oversized batch is cheaper
 * to recover from than a half-understood one.
 */
const MAX_OPS = 200

export const canvasEditInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    documentId: documentIdSchema,
    ops: z.array(canvasOpSchema).min(1).max(MAX_OPS),
    /**
     * Whether this batch CHANGES the document or PROPOSES a change to it
     * (ADR-0029). A proposal is stored beside the content, drawn on the live
     * document, and adopted or dismissed by a person.
     *
     * **The default is decided by what the batch CARRIES, not by who is
     * calling.** Content — node and edge adds, patches and removes — is
     * proposed, because nobody watches an agent type and there is no moment
     * at which a person could object (decision 3). A batch carrying anything
     * else applies: `comment.*` is the annotation layer, a lock is a claim on
     * a document rather than a change to it, and `tidy`/`region.set` have no
     * anchor to follow — the same line the layer already drew when it said
     * which verbs a proposal can carry.
     *
     * A default that refused those instead would refuse a verb this tool
     * supports, and one of its callers is the widget's comment box: a person
     * typing there would get an error rather than a comment.
     *
     * A MIXED batch applies, because the batch is all-or-nothing and
     * splitting it would be a third thing neither mode means.
     *
     * `apply` is therefore still what a surface a person is looking at
     * should pass explicitly — the product's drawing skills do, since a
     * person who asked for a drawing right now is the case decision 3
     * exempts.
     */
    mode: z.enum(['apply', 'propose']).optional(),
    /**
     * Add to the proposal already open under this id instead of opening a
     * new one — decision 8's "one request, not one call". Only meaningful
     * with `mode: 'propose'`; a batch that touches an element the proposal
     * already carries REPLACES that change rather than stacking a second
     * opinion beside it.
     */
    proposalId: annotationIdSchema.optional(),
    /**
     * Move a watching browser's viewport onto what this batch touched.
     * Defaults to true: an agent editing a board a human is looking at
     * should not leave them hunting for the change. Set false for
     * housekeeping edits that do not deserve to steal someone's view.
     */
    follow: z.boolean().optional(),
  })
  .strict()
export type CanvasEditInput = z.infer<typeof canvasEditInputSchema>

export const geometryEntrySchema = z
  .object({
    id: nodeIdSchema,
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int(),
    height: z.number().int(),
  })
  .strict()

export const canvasEditOutputSchema = z
  .object({
    documentId: documentIdSchema,
    applied: z.number().int().nonnegative(),
    /**
     * Every element the batch created, changed, moved, locked or deleted.
     * Sorted, so the payload is reproducible across runs rather than
     * carrying Set iteration order.
     */
    touched: z
      .object({
        nodes: z.array(nodeIdSchema),
        edges: z.array(nodeIdSchema),
        comments: z.array(nodeIdSchema),
      })
      .strict(),
    /**
     * Final geometry of every node this batch positioned WITHOUT being told
     * the numbers — an auto-placed add, or a node `tidy` moved. A node whose
     * coordinates the caller supplied is not listed: the caller already
     * knows them.
     */
    geometry: z.array(geometryEntrySchema),
    /** The board after the batch, so no second round trip is needed to read it. */
    snapshot: canvasSnapshotSchema,
    /**
     * What was proposed, present only in `propose` mode. The whole proposal
     * rather than a summary of it: the caller does not know the ids minted
     * or the geometry placed, and this is the same schema the document
     * stores, so there is no second shape to keep in step.
     */
    proposed: proposalSchema.optional(),
  })
  .strict()
export type CanvasEditOutput = z.infer<typeof canvasEditOutputSchema>
