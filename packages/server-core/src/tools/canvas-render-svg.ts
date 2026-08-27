import { constantRatioMeasureText, renderSceneToSvg } from '@kamiazya/whiteboard-canvas-render'
import { documentIdSchema, workspaceIdSchema } from '@kamiazya/whiteboard-model'
import { z } from 'zod'
import { assertSpatialDocument } from '../render/assert-spatial-document.js'
import { composeCanvasScene, computeSceneDimensions } from '../render/compose-canvas-scene.js'
import { resolveFileReferences } from '../render/resolve-file-references.js'
import type { ServerDeps } from '../server-deps.js'
import { loadDocument } from './document-io.js'

/**
 * `DocRef`'s document arm carries `workspaceId` (the record a consumer
 * reaches through the ref), but the derived STORAGE key deliberately omits
 * it — see doc-ref-key.ts — so this field never selects different bytes;
 * it is accepted for API symmetry with workspace-scoped tools and as a
 * future authorization-scoping hook.
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
      const { doc, canvas } = await loadDocument(deps, input.workspaceId, input.documentId)
      await assertSpatialDocument(deps, input.workspaceId, input.documentId, doc, 'wb_scene_render')
      const references = input.embedReferences
        ? await resolveFileReferences(deps, input.workspaceId, canvas)
        : undefined
      const scene = composeCanvasScene(
        canvas,
        (await deps.measure?.()) ?? constantRatioMeasureText,
        {
          ...(references === undefined ? {} : { references }),
        },
      )
      const { width, height } = computeSceneDimensions(scene)
      return { svg: renderSceneToSvg(scene), width, height }
    },
  }
}
