import { canvasIdSchema, workspaceIdSchema } from '@kamiazya/whiteboard-canvas-model'
import { renderSceneToSvg } from '@kamiazya/whiteboard-canvas-render'
import { z } from 'zod'
import type { ServerDeps } from '../create-server.js'
import { composeCanvasScene, computeCanvasDimensions } from '../render/compose-canvas-scene.js'
import { fallbackMeasureText } from '../render/fallback-measure.js'
import { loadSpatialCanvas } from '../render/load-spatial-canvas.js'

/**
 * `CanvasDocStore.loadSnapshot`'s `DocRef` (`{ kind: 'canvas', canvasId }`)
 * carries no `workspaceId` — this field is accepted for API symmetry with
 * workspace-scoped tools and as a future authorization-scoping hook, not
 * passed to the store.
 */
export const canvasRenderSvgInputSchema = z
  .object({ workspaceId: workspaceIdSchema, canvasId: canvasIdSchema })
  .strict()
export type CanvasRenderSvgInput = z.infer<typeof canvasRenderSvgInputSchema>

export const canvasRenderSvgOutputSchema = z
  .object({ svg: z.string(), width: z.number(), height: z.number() })
  .strict()
export type CanvasRenderSvgOutput = z.infer<typeof canvasRenderSvgOutputSchema>

export function createCanvasRenderSvgTool(deps: ServerDeps) {
  return {
    name: 'canvas_render_svg' as const,
    inputSchema: canvasRenderSvgInputSchema,
    outputSchema: canvasRenderSvgOutputSchema,
    async execute(input: CanvasRenderSvgInput): Promise<CanvasRenderSvgOutput> {
      const { canvas } = await loadSpatialCanvas(deps, input.canvasId)
      const scene = composeCanvasScene(canvas, fallbackMeasureText)
      const { width, height } = computeCanvasDimensions(canvas.nodes)
      return { svg: renderSceneToSvg(scene), width, height }
    },
  }
}
