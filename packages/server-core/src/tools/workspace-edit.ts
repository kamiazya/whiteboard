import {
  documentIdSchema,
  documentPathSchema,
  okfActorSchema,
  workspaceIdSchema,
} from '@kamiazya/whiteboard-model'
import { z } from 'zod'
import type { ServerDeps } from '../server-deps.js'
import { wbDocumentCreate, wbDocumentDelete } from './document-crud.js'
import { createDocumentSetTool } from './document-set.js'

/**
 * Thrown when one op in a batch cannot apply.
 *
 * Deliberately NOT `wb_canvas_edit`'s "Nothing was written". That tool edits
 * ONE document, so its whole batch is one load and one save and it can
 * honestly promise all-or-nothing. A workspace batch spans documents, and
 * each document is its own Loro doc with its own snapshot — so the ops
 * before the failure have already been saved and there is no transaction to
 * roll them back. Claiming otherwise would be a lie a caller acts on: they
 * would retry the whole batch and create the first documents twice.
 *
 * `opIndex` and the applied count are in the MESSAGE as well as on the
 * class, because only `.message` survives the MCP error path and a caller
 * repairing a rejected batch needs to know where to resume.
 */
export class WorkspaceEditError extends Error {
  constructor(
    readonly opIndex: number,
    readonly op: string,
    readonly applied: number,
    detail: string,
  ) {
    super(
      `ops[${opIndex}] (${op}) could not be applied: ${detail}. ` +
        `${applied} op(s) before it were applied and stand; ops after it were not run. ` +
        'Resume from this index rather than resending the batch.',
    )
    this.name = 'WorkspaceEditError'
  }
}

/**
 * `create` discriminates twice: on `op` like every other entry, and then on
 * `kind`, because only a markdown document takes a body. Zod refuses two
 * branches sharing a discriminator value, so the kind split is a nested
 * union rather than two flat `document.create` branches — the same rule
 * `wbDocumentCreate` encodes, expressed where the outer discriminator
 * has already been spent.
 */
const documentCreateOpSchema = z.discriminatedUnion('kind', [
  z
    .object({
      op: z.literal('document.create'),
      path: documentPathSchema,
      kind: z.literal('markdown'),
      name: z.string().optional(),
      markdown: z
        .string()
        .optional()
        // +61 visible bytes, and the BEHAVIOUR is what removes the retry —
        // a bare body now works whether or not this says so. The sentence
        // buys predictability: a caller who cares what `type` it gets
        // should not have to find out by reading the document back.
        .describe(
          'The document as OKF Markdown; without a `---` block the string is the body, typed `note`. Omit to create it empty.',
        ),
    })
    .strict(),
  z
    .object({
      op: z.literal('document.create'),
      path: documentPathSchema,
      kind: z.literal('spatial'),
      name: z.string().optional(),
    })
    .strict(),
])

/**
 * Discriminated on `op`, not a plain `z.union`. A plain union reports a
 * rejected op as `ops.0: Invalid input` and nothing else — it has no way to
 * say which branch the caller meant, so the ONE thing an agent needs in
 * order to repair the call is exactly what is missing. Discriminating picks
 * the branch by `op` and reports that branch's own issue, naming the key.
 *
 * `documentCreateOpSchema` is itself a union (on `kind`), which is legal
 * here because every one of its members carries the same `op` literal.
 */
const workspaceOpSchema = z.discriminatedUnion('op', [
  documentCreateOpSchema,
  z
    .object({ op: z.literal('document.set'), documentId: documentIdSchema, markdown: z.string() })
    .strict(),
  z.object({ op: z.literal('document.delete'), documentId: documentIdSchema }).strict(),
])

export const workspaceEditInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    createWorkspace: z
      .boolean()
      .optional()
      .describe('Set true to create the workspace if it does not exist yet.'),
    /**
     * ONE actor for the whole batch rather than one per op, because a batch
     * has one producer and repeating the same string per op is the cost
     * this shape exists to remove — the same reason `wb_facet_set` takes one
     * shared `facets` and `wb_version_save` one shared `label`.
     *
     * Applies to the ops that write CONTENT (`document.create` with a body,
     * `document.set`); a delete authors nothing to attribute. ADR-0016's
     * rule still governs what happens to it: a document that already
     * declares `generated` keeps its own, because that is provenance rather
     * than a field this write owns.
     */
    actor: okfActorSchema
      .optional()
      .describe(
        "Who is producing this batch's content, in OKF's actor convention: `<producer>/<version>` for an agent or tool (e.g. `claude-code/2.1`), `human:<id>` for a person, `process:<id>` for an automated process. Recorded as OKF `generated.by` on the documents this batch writes. Identify yourself here; omitted, the writes are attributed to the server rather than to you.",
      ),
    ops: z
      .array(workspaceOpSchema)
      .min(1)
      .describe('Applied in order. A failing op stops the run; the ops before it stand.'),
  })
  .strict()
export type WorkspaceEditInput = z.infer<typeof workspaceEditInputSchema>

export const workspaceEditOutputSchema = z
  .object({
    /**
     * The workspace the batch applied to, as its CANONICAL id (ADR-0019).
     * Always present, not only when `createWorkspace: true` minted one: a
     * caller that addressed an existing workspace by its segment learns the
     * id behind it, and a caller that created one learns what the server
     * minted. Without it a bootstrapping batch is unusable in the same way
     * a bootstrapping create was — the server picks an id,
     * files the whole batch under it, and never says which.
     */
    workspaceId: workspaceIdSchema,
    applied: z
      .number()
      .int()
      .min(0)
      .describe('How many ops ran. Equal to `ops.length` on success.'),
    results: z
      .array(
        z
          .object({
            op: z.string(),
            documentId: documentIdSchema.optional(),
            path: documentPathSchema.optional(),
          })
          .strict(),
      )
      .describe(
        'One entry per applied op, in order. A `document.create` carries the id it minted — without that a caller spends a round trip fetching ids, which is the cost this tool exists to remove.',
      ),
  })
  .strict()
export type WorkspaceEditOutput = z.infer<typeof workspaceEditOutputSchema>

/**
 * One tool for workspace-level mutation: create, set and delete documents in
 * a single call.
 *
 * The shape follows `wb_canvas_edit` (ADR-0010) because the problem rhymes —
 * filing five findings cost ten calls — but the guarantee cannot. See
 * `WorkspaceEditError`.
 *
 * Every op DELEGATES to the single-document tool that already owns it, so
 * there is one implementation of "create a document" and one of "write a
 * body", not a batch copy that drifts from them.
 */
type WorkspaceEditOp = WorkspaceEditInput['ops'][number]
type OpNamed<K extends WorkspaceEditOp['op']> = Extract<WorkspaceEditOp, { op: K }>
type ResultRow = WorkspaceEditOutput['results'][number]

/** What one op of a batch is applied against. */
interface WorkspaceEditContext {
  readonly deps: ServerDeps
  /** The single-document write tool, built once for the whole batch. */
  readonly set: ReturnType<typeof createDocumentSetTool>
  /**
   * The workspace ops 1..n address, which op 0 may have MINTED — see the
   * note at `applyOps`. A handler that changes it says so by returning it.
   */
  readonly workspaceId: string
  readonly actor: WorkspaceEditInput['actor']
  readonly createWorkspace: boolean
  /** Which op this is. Only op 0 may bootstrap a workspace. */
  readonly index: number
}

/** What an op did: its result row, and the workspace it left the batch in. */
interface OpOutcome {
  readonly result: ResultRow
  readonly workspaceId?: string
}

/**
 * One handler per op, keyed by the op's own discriminator.
 *
 * A TABLE rather than an if/else chain, for the reason `canvas-edit-handlers`
 * is one: the chain ended in a bare `else` that ran the DELETE, so a fourth
 * op added to the schema would have been deleted documents instead of
 * failing to compile. The mapped type owes a handler per member.
 */
const WORKSPACE_EDIT_HANDLERS: {
  [K in WorkspaceEditOp['op']]: (ctx: WorkspaceEditContext, op: OpNamed<K>) => Promise<OpOutcome>
} = {
  'document.create': async (ctx, op) => {
    const created = await wbDocumentCreate(ctx.deps, {
      workspaceId: ctx.workspaceId,
      path: op.path,
      // The actor rides only on the markdown arm. A spatial create
      // authors no content — its canvas is built by `wb_canvas_edit`
      // — so `wbDocumentCreateInputSchema`'s spatial arm has no
      // `actor` field and, being `.strict()`, refuses one. Passing it
      // unconditionally made a mixed-kind batch fail at the spatial
      // op with an unrecognized-key error, which no test sending one
      // kind at a time could see.
      ...(op.kind === 'markdown'
        ? {
            kind: 'markdown' as const,
            ...(op.markdown === undefined ? {} : { markdown: op.markdown }),
            ...(ctx.actor === undefined ? {} : { actor: ctx.actor }),
          }
        : { kind: 'spatial' as const }),
      ...(op.name === undefined ? {} : { name: op.name }),
      // Only op 0 may bootstrap, and this is belt-and-braces rather than a
      // load-bearing guard: the flag is an IDEMPOTENT bootstrap (see
      // mintWorkspace), and a later op only runs at all because op 0
      // succeeded — which means the handle already resolves. Removing the
      // index check is therefore unobservable, and no test can catch it.
      // Kept because it states the intent at the one place a reader asks.
      ...(ctx.index === 0 && ctx.createWorkspace ? { createWorkspace: true } : {}),
    })
    return {
      result: { op: op.op, documentId: created.documentId, path: created.path },
      workspaceId: created.workspaceId,
    }
  },

  'document.set': async (ctx, op) => {
    await ctx.set.execute({
      workspaceId: ctx.workspaceId,
      documentId: op.documentId,
      markdown: op.markdown,
      ...(ctx.actor === undefined ? {} : { actor: ctx.actor }),
    })
    return { result: { op: op.op, documentId: op.documentId } }
  },

  'document.delete': async (ctx, op) => {
    await wbDocumentDelete(ctx.deps, {
      workspaceId: ctx.workspaceId,
      documentId: op.documentId,
    })
    return { result: { op: op.op, documentId: op.documentId } }
  },
}

function applyOp(ctx: WorkspaceEditContext, op: WorkspaceEditOp): Promise<OpOutcome> {
  const handle = WORKSPACE_EDIT_HANDLERS[op.op] as (
    ctx: WorkspaceEditContext,
    op: WorkspaceEditOp,
  ) => Promise<OpOutcome>
  return handle(ctx, op)
}

export function createWorkspaceEditTool(deps: ServerDeps) {
  return {
    name: 'wb_workspace_edit' as const,
    description:
      'Create, replace and delete several documents in one call. Ops apply in order; a failing op stops the run and the ops before it stand, because documents are separate CRDTs and a batch across them is not one transaction. Returns the ids it minted.',
    inputSchema: workspaceEditInputSchema,
    outputSchema: workspaceEditOutputSchema,
    execute: async (rawInput: WorkspaceEditInput): Promise<WorkspaceEditOutput> => {
      const input = workspaceEditInputSchema.parse(rawInput)
      const set = createDocumentSetTool(deps)
      const results: ResultRow[] = []
      // The batch addresses ONE workspace, and a bootstrapping first op is
      // what decides which. Creating is ADR-0019's mint boundary, so after
      // op 0 the caller's handle is that workspace's SEGMENT rather than its
      // id — and every later op in this loop reaches the port directly, with
      // no resolution step between. Carrying the id the create reported is
      // what keeps ops 1..n inside the workspace op 0 made, instead of
      // failing against a handle that now names nothing.
      let workspaceId = input.workspaceId

      for (const [index, op] of input.ops.entries()) {
        try {
          const outcome = await applyOp(
            {
              deps,
              set,
              workspaceId,
              actor: input.actor,
              createWorkspace: input.createWorkspace === true,
              index,
            },
            op,
          )
          if (outcome.workspaceId !== undefined) workspaceId = outcome.workspaceId
          results.push(outcome.result)
        } catch (err) {
          throw new WorkspaceEditError(
            index,
            op.op,
            results.length,
            err instanceof Error ? err.message : String(err),
          )
        }
      }

      return { workspaceId, applied: results.length, results }
    },
  }
}
