import { canvasIdSchema, workspaceIdSchema } from '@kamiazya/whiteboard-canvas-model'
import { serializeSpatial } from '@kamiazya/whiteboard-canvas-codec'
import { z } from 'zod'
import type { ServerDeps } from '../create-server.js'
import { loadSpatialCanvas } from '../render/load-spatial-canvas.js'

/**
 * `CanvasDocStore.loadSnapshot`'s `DocRef` carries no `workspaceId` — this
 * field is accepted for API symmetry with workspace-scoped tools and as a
 * future authorization-scoping hook, not passed to the store.
 */
export const canvasExportJsonCanvasInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    canvasId: canvasIdSchema,
    options: z
      .object({ strict: z.boolean().default(false) })
      .strict()
      .optional(),
  })
  .strict()
export type CanvasExportJsonCanvasInput = z.infer<typeof canvasExportJsonCanvasInputSchema>

export const canvasExportJsonCanvasOutputSchema = z.object({ json: z.string() }).strict()
export type CanvasExportJsonCanvasOutput = z.infer<typeof canvasExportJsonCanvasOutputSchema>

export function createCanvasExportJsonCanvasTool(deps: ServerDeps) {
  return {
    name: 'canvas_export_json_canvas' as const,
    inputSchema: canvasExportJsonCanvasInputSchema,
    outputSchema: canvasExportJsonCanvasOutputSchema,
    async execute(input: CanvasExportJsonCanvasInput): Promise<CanvasExportJsonCanvasOutput> {
      const { canvas } = await loadSpatialCanvas(deps, input.canvasId)
      const mode = input.options?.strict === true ? 'strict' : 'extended'
      return { json: serializeSpatial(canvas, mode) }
    },
  }
}
