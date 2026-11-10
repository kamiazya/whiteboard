import { serializeSpatial } from '@kamiazya/whiteboard-codec'
import { documentIdSchema, workspaceCanonicalIdSchema } from '@kamiazya/whiteboard-model'
import { ZodError, z } from 'zod'
import { loadDocument } from '../document-io.js'
import type { ServerDeps } from '../server-deps.js'
import { assertDocumentInWorkspace } from './assert-document-in-workspace.js'
import { DocumentSerializeError } from './errors.js'

/**
 * `workspaceId` is passed to the store inside the `DocRef`: the daemon's
 * workspace plane resolves the document through that workspace's tree.
 */
const exportJsonCanvasInputSchema = z
  .object({
    workspaceId: workspaceCanonicalIdSchema,
    documentId: documentIdSchema,
    options: z
      .object({ strict: z.boolean().default(false) })
      .strict()
      .optional(),
  })
  .strict()
export type ExportJsonCanvasInput = z.infer<typeof exportJsonCanvasInputSchema>

const exportJsonCanvasOutputSchema = z.object({ json: z.string() }).strict()
export type ExportJsonCanvasOutput = z.infer<typeof exportJsonCanvasOutputSchema>

/**
 * Serialise a document as JSON Canvas. Strict mode drops the x-whiteboard
 * extension.
 *
 * Not an MCP tool: `wb_document_get` chooses this projection for a spatial
 * document.
 *
 * The writer is the realm's Rust core, which refuses what it cannot carry (a
 * canvas past its cap, a link whose host it has no tables for) and, in strict
 * mode, a canvas that is no JSON Canvas 1.0 document. Both arrive as a
 * `ZodError`, reported as the one document's own failure so a batch read says
 * which document and why.
 */
export async function exportJsonCanvas(
  deps: ServerDeps,
  input: ExportJsonCanvasInput,
): Promise<ExportJsonCanvasOutput> {
  await assertDocumentInWorkspace(deps.documentIndex, input.workspaceId, input.documentId)
  const { canvas } = await loadDocument(deps, input.workspaceId, input.documentId)
  const mode = input.options?.strict === true ? 'strict' : 'extended'
  try {
    return { json: serializeSpatial(canvas, mode) }
  } catch (error) {
    if (error instanceof ZodError) {
      throw new DocumentSerializeError(input.documentId, 'JSON Canvas', error)
    }
    throw error
  }
}
