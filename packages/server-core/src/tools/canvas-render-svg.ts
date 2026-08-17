import { renderSceneToSvg } from '@kamiazya/whiteboard-canvas-render'
import { documentIdSchema, workspaceIdSchema } from '@kamiazya/whiteboard-model'
import { z } from 'zod'
import { composeCanvasScene, computeSceneDimensions } from '../render/compose-canvas-scene.js'
import { fallbackMeasureText } from '../render/fallback-measure.js'
import { loadSpatialCanvas } from '../render/load-spatial-canvas.js'
import { resolveFileReferences } from '../render/resolve-file-references.js'
import type { ServerDeps } from '../server-deps.js'

/**
 * `DocumentStore.loadSnapshot`'s `DocRef` (`{ kind: 'canvas', documentId }`)
 * carries no `workspaceId` — this field is accepted for API symmetry with
 * workspace-scoped tools and as a future authorization-scoping hook, not
 * passed to the store.
 */
export const canvasRenderSvgInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    documentId: documentIdSchema,
    embedReferences: z
      .boolean()
      .default(false)
      .describe(
        "Resolve this canvas's file-node references against the workspace. Today that means a reference to a markdown document renders that document's body inside the node, and every reference gets its readable name instead of its raw id; other reference kinds keep the plain card. Off by default so the render stays a pure function of this canvas alone.",
      ),
  })
  .strict()
export type CanvasRenderSvgInput = z.infer<typeof canvasRenderSvgInputSchema>

export const canvasRenderSvgOutputSchema = z
  .object({ svg: z.string(), width: z.number(), height: z.number() })
  .strict()
export type CanvasRenderSvgOutput = z.infer<typeof canvasRenderSvgOutputSchema>

export function createCanvasRenderSvgTool(deps: ServerDeps) {
  return {
    name: 'wb_scene_render' as const,
    description:
      'Render the laid-out scene as SVG. A one-way projection — the SVG cannot be parsed back into a document.',
    inputSchema: canvasRenderSvgInputSchema,
    outputSchema: canvasRenderSvgOutputSchema,
    async execute(input: CanvasRenderSvgInput): Promise<CanvasRenderSvgOutput> {
      const { canvas } = await loadSpatialCanvas(deps, input.documentId)
      const references = input.embedReferences
        ? await resolveFileReferences(deps, input.workspaceId, canvas)
        : undefined
      const scene = composeCanvasScene(canvas, fallbackMeasureText, {
        ...(references === undefined ? {} : { references }),
      })
      const { width, height } = computeSceneDimensions(scene)
      return { svg: renderSceneToSvg(scene), width, height }
    },
  }
}
