import type { SceneDigest } from '@kamiazya/whiteboard-canvas-render'
import { sceneDigest, sceneDigestSchema } from '@kamiazya/whiteboard-canvas-render'
import { documentIdSchema, workspaceIdSchema } from '@kamiazya/whiteboard-model'
import { z } from 'zod'
import { composeCanvasScene } from '../render/compose-canvas-scene.js'
import { fallbackMeasureText } from '../render/fallback-measure.js'
import { loadSpatialCanvas } from '../render/load-spatial-canvas.js'
import type { ServerDeps } from '../server-deps.js'

/**
 * `DocumentStore.loadSnapshot`'s `DocRef` carries no `workspaceId` — this
 * field is accepted for API symmetry with workspace-scoped tools and as a
 * future authorization-scoping hook, not passed to the store.
 */
export const canvasDigestInputSchema = z
  .object({ workspaceId: workspaceIdSchema, documentId: documentIdSchema })
  .strict()
export type CanvasDigestInput = z.infer<typeof canvasDigestInputSchema>

export function createCanvasDigestTool(deps: ServerDeps) {
  return {
    name: 'wb_scene_digest' as const,
    description:
      'Summarise the laid-out scene for an agent that cannot see the canvas. Derived from layout, not read back from stored content.',
    inputSchema: canvasDigestInputSchema,
    outputSchema: sceneDigestSchema,
    async execute(input: CanvasDigestInput): Promise<SceneDigest> {
      const { canvas } = await loadSpatialCanvas(deps, input.documentId)
      const scene = composeCanvasScene(canvas, fallbackMeasureText)
      return sceneDigest(scene)
    },
  }
}
