import { serializeSpatial } from '@kamiazya/whiteboard-canvas-codec'
import { canvasIdSchema, workspaceIdSchema } from '@kamiazya/whiteboard-canvas-model'
import { z } from 'zod'
import { loadSpatialCanvas } from '../render/load-spatial-canvas.js'
import type { ServerDeps } from '../server-deps.js'

/**
 * `CanvasDocStore.loadSnapshot`'s `DocRef` carries no `workspaceId` — this
 * field is accepted for API symmetry with workspace-scoped tools and as a
 * future authorization-scoping hook, not passed to the store.
 */
export const exportJsonCanvasInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    canvasId: canvasIdSchema,
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
  const { canvas } = await loadSpatialCanvas(deps, input.canvasId)
  const mode = input.options?.strict === true ? 'strict' : 'extended'
  return { json: serializeSpatial(canvas, mode) }
}
