import { canvasIdSchema, workspaceIdSchema } from '@kamiazya/whiteboard-canvas-model'
import type { SceneDigest } from '@kamiazya/whiteboard-canvas-render'
import { sceneDigest, sceneDigestSchema } from '@kamiazya/whiteboard-canvas-render'
import { z } from 'zod'
import { composeCanvasScene } from '../render/compose-canvas-scene.js'
import { fallbackMeasureText } from '../render/fallback-measure.js'
import { loadSpatialCanvas } from '../render/load-spatial-canvas.js'
import type { ServerDeps } from '../server-deps.js'

/**
 * `CanvasDocStore.loadSnapshot`'s `DocRef` carries no `workspaceId` — this
 * field is accepted for API symmetry with workspace-scoped tools and as a
 * future authorization-scoping hook, not passed to the store.
 */
export const canvasDigestInputSchema = z
  .object({ workspaceId: workspaceIdSchema, canvasId: canvasIdSchema })
  .strict()
export type CanvasDigestInput = z.infer<typeof canvasDigestInputSchema>

export function createCanvasDigestTool(deps: ServerDeps) {
  return {
    name: 'wb_scene_digest' as const,
    inputSchema: canvasDigestInputSchema,
    outputSchema: sceneDigestSchema,
    async execute(input: CanvasDigestInput): Promise<SceneDigest> {
      const { canvas } = await loadSpatialCanvas(deps, input.canvasId)
      const scene = composeCanvasScene(canvas, fallbackMeasureText)
      return sceneDigest(scene)
    },
  }
}
