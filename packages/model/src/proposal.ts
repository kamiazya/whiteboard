import { z } from 'zod'
import { annotationIdSchema, textAnchorSchema } from './annotation.js'
import { nodeIdSchema } from './ids.js'
import { canvasColorSchema, canvasEdgeSchema, spatialNodeSchema } from './spatial.js'
import { okfActorSchema, okfTimestampSchema } from './trust.js'

/**
 * The proposal layer (ADR-0029): a change somebody wants made, carried on the
 * live document until a person adopts or dismisses it.
 *
 * A proposal is an ANCHORED CHANGE rather than a point in time, and the ADR
 * derives that rather than asserting it. Following the document as it moves
 * rules out a frontier — a fixed point in the oplog does not carry a proposal
 * along, so an edit elsewhere would strand it at a state that is no longer
 * anyone's. Adopting part of a batch rules out one indivisible thing — a
 * frontier is checked out whole or not at all. What is left is the shape the
 * annotation layer already has for a different payload: keyed to identity,
 * following edits, opened and closed.
 *
 * Four parts, and each earns its place:
 *
 * - **anchor** — the element id, or a passage selector. What the change is
 *   ABOUT, so it survives the document moving underneath it.
 * - **intended change** — the edit itself. Not new: `wb_canvas_edit`'s op
 *   union is already an anchored intended change, and proposing is storing
 *   the op instead of applying it.
 * - **assumed** — what the anchor held when the proposal was made. ONE field
 *   doing two jobs: drawing the change needs the previous value, to strike
 *   through beside the new one; detecting a conflict needs the previous
 *   value, to compare against what the anchor holds now. They are the same
 *   value, so storing it twice would be storing a disagreement.
 * - **provenance** — who proposed it and when. Optional for the reason a
 *   comment message's is: identity and time are keeper concerns, and a
 *   browser-kept workspace has no signed-in author to record.
 */

/**
 * What `node.patch` may change. Deliberately limited to the geometry/style
 * fields every node type shares plus `label` (which only a group declares) —
 * not the per-type content fields. Patching `label` onto a text node is a
 * silent no-op after re-parse, because the per-type node schemas are not
 * strict and an unrecognized key is stripped rather than rejected.
 *
 * Hand-written rather than derived, unlike the edge patch below, because
 * `spatialNodeSchema` is a union of four and there is no single object to
 * narrow: the shared subset is a judgement, and this is where it is recorded.
 */
export const nodePatchFieldsSchema = z
  .object({
    x: z.number().int().optional(),
    y: z.number().int().optional(),
    width: z.number().int().nonnegative().optional(),
    height: z.number().int().nonnegative().optional(),
    color: canvasColorSchema.optional(),
    label: z.string().optional(),
  })
  .strict()

export type NodePatchFields = z.infer<typeof nodePatchFieldsSchema>

/**
 * What `edge.patch` may change: everything an edge has except its identity.
 * Derived from the stored schema rather than restated beside it, so a field
 * added to an edge reaches this for free.
 */
export const edgePatchFieldsSchema = canvasEdgeSchema.omit({ id: true }).partial().strict()

export type EdgePatchFields = z.infer<typeof edgePatchFieldsSchema>

/**
 * Where one change stands. The DECISION is per change (ADR-0029 decision 4),
 * which is why the status lives here and the batch has none: "nine of these
 * are right and one is not" is the common case, and without a per-change
 * verdict the only reply is to dismiss everything and ask again.
 *
 * A decided change stays in the record rather than being deleted, the way a
 * resolved thread does (ADR-0025 decision 2): what closed it is part of what
 * happened to the document, and two peers deciding concurrently converge on a
 * verdict rather than on a gap.
 */
export const proposedChangeStatusSchema = z.enum(['open', 'adopted', 'dismissed'])

export type ProposedChangeStatus = z.infer<typeof proposedChangeStatusSchema>

/** What every change carries regardless of verb: its own identity and its verdict. */
const changeIdentity = {
  /** The change's own id — what an Adopt or a Dismiss names. */
  id: annotationIdSchema,
  status: proposedChangeStatusSchema,
} as const

/**
 * A prior may omit a field the change sets, and that means "the anchor held
 * nothing there" — setting a colour on a node that had none is an ordinary
 * proposal, not a malformed one. The other direction is refused: a prior for
 * a field the change does NOT touch would make decision 5's conflict check
 * fire on somebody else's unrelated edit, which is exactly the "only a REAL
 * collision is flagged" rule failing.
 *
 * This is the strongest structural claim available — that the prior is
 * ACCURATE is the producer's to get right, and no schema can check it — and
 * it is the one that catches the mistake with a visible symptom.
 */
function declaresNoPriorOutsideItsChange(change: {
  readonly patch: Record<string, unknown>
  readonly assumed: Record<string, unknown>
}): boolean {
  return Object.keys(change.assumed).every((field) => field in change.patch)
}

const PRIOR_SCOPE_MESSAGE = {
  message: 'a prior value may only name fields the change itself sets',
} as const

/**
 * One anchored change. The union is CLOSED, so every renderer's switch over
 * it stays exhaustive and a new verb cannot arrive without someone deciding
 * what its prior value is.
 *
 * The verbs are `wb_canvas_edit`'s anchored ones plus prose. What is
 * deliberately absent is as much of the design as what is here: `tidy` has no
 * anchor (it is about the whole board), and `region.set` is declarative — it
 * deletes what it was not told about, so it can be neither drawn as a set of
 * struck-through priors nor adopted in part. Both fail decisions 4 and 5 on
 * their face. `comment.*` is the annotation layer rather than content, and a
 * lock is a claim on a document rather than a change to it.
 *
 * A proposed node or edge is stored RESOLVED — real id, real geometry — not
 * as the draft the tool accepts. The renderer has to draw it dashed, in
 * place, before anyone adopts it, and a draft with its geometry left out has
 * no box to draw.
 */
export const proposedChangeSchema = z.discriminatedUnion('op', [
  z.object({ ...changeIdentity, op: z.literal('node.add'), node: spatialNodeSchema }).strict(),
  z
    .object({
      ...changeIdentity,
      op: z.literal('node.patch'),
      nodeId: nodeIdSchema,
      patch: nodePatchFieldsSchema,
      assumed: nodePatchFieldsSchema,
    })
    .strict()
    .refine(declaresNoPriorOutsideItsChange, PRIOR_SCOPE_MESSAGE),
  // The prior is the WHOLE node, because a removal touches all of it — and
  // because the renderer draws the node it would delete, struck through.
  z
    .object({
      ...changeIdentity,
      op: z.literal('node.remove'),
      nodeId: nodeIdSchema,
      assumed: spatialNodeSchema,
    })
    .strict(),
  z.object({ ...changeIdentity, op: z.literal('edge.add'), edge: canvasEdgeSchema }).strict(),
  z
    .object({
      ...changeIdentity,
      op: z.literal('edge.patch'),
      edgeId: nodeIdSchema,
      patch: edgePatchFieldsSchema,
      assumed: edgePatchFieldsSchema,
    })
    .strict()
    .refine(declaresNoPriorOutsideItsChange, PRIOR_SCOPE_MESSAGE),
  z
    .object({
      ...changeIdentity,
      op: z.literal('edge.remove'),
      edgeId: nodeIdSchema,
      assumed: canvasEdgeSchema,
    })
    .strict(),
  /**
   * Prose (ADR-0029 decision 6): a range of body text and the text intended
   * to replace it. `text` and `assumed` are both allowed to be empty — an
   * insertion replaces nothing, a deletion replaces with nothing — so neither
   * carries a minimum.
   */
  z
    .object({
      ...changeIdentity,
      op: z.literal('body.replace'),
      anchor: textAnchorSchema,
      text: z.string(),
      assumed: z.string(),
    })
    .strict(),
])

export type ProposedChange = z.infer<typeof proposedChangeSchema>

/**
 * The arms whose subject is the CANVAS. `body.replace` is about a passage of
 * prose, so anything judging or applying a change against a canvas takes this
 * narrower type — the prose arm gets its own judge with the markdown surface,
 * and until then its absence is visible in the types rather than hidden
 * behind a verdict nobody computed.
 */
export type SpatialProposedChange = Exclude<ProposedChange, { op: 'body.replace' }>

/**
 * The verbs the union carries, read off the schema so a new one cannot be
 * added without the tests that enumerate them noticing.
 */
export const PROPOSED_CHANGE_OPS: readonly ProposedChange['op'][] =
  proposedChangeSchema.options.map((option) => option.shape.op.value)

/**
 * The batch that arrived together: what an agent produced in answer to one
 * request (ADR-0029 decision 8), which is the unit at which it says it is
 * finished. Not one tool call — a single request often makes several — and
 * not a whole conversation, where unrelated changes would share one Adopt.
 *
 * It carries no status of its own. Whether a proposal is still open follows
 * from its changes, and a second place to write it would leave "which one
 * counts?" unanswerable the moment the two disagreed.
 */
export const proposalSchema = z
  .object({
    id: annotationIdSchema,
    author: okfActorSchema.optional(),
    createdAt: okfTimestampSchema.optional(),
    changes: z.array(proposedChangeSchema).min(1, 'a proposal carries at least one change'),
  })
  .strict()

export type Proposal = z.infer<typeof proposalSchema>
