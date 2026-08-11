import {
  canvasIdSchema,
  nodeIdSchema,
  spatialCanvasSchema,
  workspaceIdSchema,
} from '@kamiazya/whiteboard-canvas-model'
import { tidyNodes } from '@kamiazya/whiteboard-canvas-render'
import { readNodeLocks } from '@kamiazya/whiteboard-canvas-workspace'
import { z } from 'zod'
import type { ServerDeps } from '../server-deps.js'
import { loadCanvasDoc, saveCanvasDoc } from './canvas-doc-io.js'
import { PatchValidationError } from './errors.js'
import { withReindex } from './with-reindex.js'
import { assertCanvasInWorkspace } from './workspace-tree-io.js'

export const tidyCanvasInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    canvasId: canvasIdSchema,
    /** Restrict tidy to these unit roots; everything else stands as a fixed obstacle. */
    scope: z.array(nodeIdSchema).min(1).optional(),
  })
  .strict()
export type TidyCanvasInput = z.infer<typeof tidyCanvasInputSchema>

export const tidyCanvasOutputSchema = z
  .object({
    canvasId: canvasIdSchema,
    /** Only the nodes that actually moved, with their new positions. */
    moved: z.array(
      z.object({ id: nodeIdSchema, x: z.number().int(), y: z.number().int() }).strict(),
    ),
  })
  .strict()
export type TidyCanvasOutput = z.infer<typeof tidyCanvasOutputSchema>

export function createTidyCanvasTool(deps: ServerDeps) {
  return {
    name: 'tidy_canvas' as const,
    inputSchema: tidyCanvasInputSchema,
    outputSchema: tidyCanvasOutputSchema,
    execute: withReindex(deps, async (input: TidyCanvasInput): Promise<TidyCanvasOutput> => {
      await assertCanvasInWorkspace(deps.canvasDocStore, input.workspaceId, input.canvasId)
      const { doc, canvas } = await loadCanvasDoc(deps, input.canvasId)

      // Locks bind agents exactly as they bind the editor: a locked node is
      // a fixed obstacle tidy routes around, never a participant it moves.
      const locks = readNodeLocks(doc)
      const moved = tidyNodes(canvas.nodes, {
        scope: input.scope === undefined ? undefined : new Set(input.scope),
        locked: (id) => locks.has(id),
      })
      if (moved.length === 0) return { canvasId: input.canvasId, moved: [] }

      const target = new Map(moved.map((move) => [move.id, move]))
      const candidateCanvas = {
        nodes: canvas.nodes.map((node) => {
          const move = target.get(node.id)
          return move === undefined ? node : { ...node, x: move.x, y: move.y }
        }),
        edges: canvas.edges,
      }
      const parsed = spatialCanvasSchema.safeParse(candidateCanvas)
      if (!parsed.success) throw new PatchValidationError(parsed.error.issues)

      await saveCanvasDoc(deps, input.canvasId, doc, parsed.data)

      return { canvasId: input.canvasId, moved: [...moved] }
    }),
  }
}
