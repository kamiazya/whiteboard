import { documentIdSchema, documentPathSchema, workspaceIdSchema } from '@kamiazya/whiteboard-model'
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
 * `wb_document_create` encodes, expressed where the outer discriminator
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
        .describe('The document as OKF Markdown. Omit to create it empty.'),
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

const workspaceOpSchema = z.union([
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
    ops: z
      .array(workspaceOpSchema)
      .min(1)
      .describe('Applied in order. A failing op stops the run; the ops before it stand.'),
  })
  .strict()
export type WorkspaceEditInput = z.infer<typeof workspaceEditInputSchema>

export const workspaceEditOutputSchema = z
  .object({
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
      const results: WorkspaceEditOutput['results'] = []

      for (const [index, op] of input.ops.entries()) {
        try {
          if (op.op === 'document.create') {
            const created = await wbDocumentCreate(deps, {
              workspaceId: input.workspaceId,
              path: op.path,
              ...(op.kind === 'markdown'
                ? {
                    kind: 'markdown' as const,
                    ...(op.markdown === undefined ? {} : { markdown: op.markdown }),
                  }
                : { kind: 'spatial' as const }),
              ...(op.name === undefined ? {} : { name: op.name }),
              // Only the first op may bootstrap the workspace; asking again
              // per op would make a typo'd id create one silently.
              ...(index === 0 && input.createWorkspace === true ? { createWorkspace: true } : {}),
            })
            results.push({ op: op.op, documentId: created.documentId, path: created.path })
          } else if (op.op === 'document.set') {
            await set.execute({
              workspaceId: input.workspaceId,
              documentId: op.documentId,
              markdown: op.markdown,
            })
            results.push({ op: op.op, documentId: op.documentId })
          } else {
            await wbDocumentDelete(deps, {
              workspaceId: input.workspaceId,
              documentId: op.documentId,
            })
            results.push({ op: op.op, documentId: op.documentId })
          }
        } catch (err) {
          throw new WorkspaceEditError(
            index,
            op.op,
            results.length,
            err instanceof Error ? err.message : String(err),
          )
        }
      }

      return { applied: results.length, results }
    },
  }
}
