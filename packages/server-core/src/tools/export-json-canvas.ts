import { serializeSpatial } from '@kamiazya/whiteboard-codec'
import { documentIdSchema, workspaceIdSchema } from '@kamiazya/whiteboard-model'
import { z } from 'zod'
import type { ServerDeps } from '../server-deps.js'
import { loadDocument } from './document-io.js'

/**
 * `DocumentStore.loadSnapshot`'s `DocRef` carries no `workspaceId` — this
 * field is accepted for API symmetry with workspace-scoped tools and as a
 * future authorization-scoping hook, not passed to the store.
 */
export const exportJsonCanvasInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    documentId: documentIdSchema,
    options: z
      .object({ strict: z.boolean().default(false) })
      .strict()
      .optional(),
  })
  .strict()
export type ExportJsonCanvasInput = z.infer<typeof exportJsonCanvasInputSchema>

export const exportJsonCanvasOutputSchema = z.object({ json: z.string() }).strict()
export type ExportJsonCanvasOutput = z.infer<typeof exportJsonCanvasOutputSchema>

/**
 * Serialise a document as JSON Canvas. Strict mode drops the x-whiteboard
 * extension.
 *
 * Not an MCP tool: `wb_document_get` chooses this projection for a spatial
 * document.
 */
export async function exportJsonCanvas(
  deps: ServerDeps,
  input: ExportJsonCanvasInput,
): Promise<ExportJsonCanvasOutput> {
  const { canvas } = await loadDocument(deps, input.workspaceId, input.documentId)
  const mode = input.options?.strict === true ? 'strict' : 'extended'
  return { json: serializeSpatial(canvas, mode) }
}
