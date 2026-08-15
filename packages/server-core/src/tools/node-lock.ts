import { canvasIdSchema, nodeIdSchema, workspaceIdSchema } from '@kamiazya/whiteboard-canvas-model'
import { setNodeLock } from '@kamiazya/whiteboard-canvas-workspace'
import { z } from 'zod'
import type { ServerDeps } from '../server-deps.js'
import { assertCanvasInWorkspace } from './assert-canvas-in-workspace.js'
import { loadCanvasDoc, saveDocSnapshot } from './canvas-doc-io.js'
import { NodeNotFoundError } from './errors.js'

/**
 * Lock/unlock is the ONE mutation a locked node still accepts (user
 * decision 2026-08-09): a lock an agent cannot lift would need a human at
 * the keyboard to undo an agent's own mistake.
 *
 * The lock itself is editor state, not canvas content — it lives in the
 * doc's sidecar map (see canvas-workspace's `setNodeLock`), so it is
 * durable and syncs to peers, yet never appears in an export, a render,
 * or a JSON Canvas file.
 */
export const nodeLockInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    canvasId: canvasIdSchema,
    nodeId: nodeIdSchema,
    locked: z.boolean(),
  })
  .strict()
export type NodeLockInput = z.infer<typeof nodeLockInputSchema>

export const nodeLockOutputSchema = z
  .object({
    canvasId: canvasIdSchema,
    nodeId: nodeIdSchema,
    locked: z.boolean(),
  })
  .strict()
export type NodeLockOutput = z.infer<typeof nodeLockOutputSchema>

export function createNodeLockTool(deps: ServerDeps) {
  return {
    name: 'wb_node_lock' as const,
    description: 'Lock or unlock a node so other clients cannot move or edit it.',
    inputSchema: nodeLockInputSchema,
    outputSchema: nodeLockOutputSchema,
    execute: async (input: NodeLockInput): Promise<NodeLockOutput> => {
      await assertCanvasInWorkspace(deps.documentIndex, input.workspaceId, input.canvasId)
      const { doc, canvas } = await loadCanvasDoc(deps, input.canvasId)

      // Reject a ghost id rather than storing a lock nothing can ever
      // clear from the UI (the editor only offers unlock on a real node).
      if (!canvas.nodes.some((node) => node.id === input.nodeId)) {
        throw new NodeNotFoundError(input.canvasId, input.nodeId)
      }

      setNodeLock(doc, input.nodeId, input.locked)
      await saveDocSnapshot(deps, input.canvasId, doc)

      return { canvasId: input.canvasId, nodeId: input.nodeId, locked: input.locked }
    },
  }
}
