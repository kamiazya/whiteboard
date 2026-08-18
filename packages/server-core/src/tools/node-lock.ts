import { setNodeLock } from '@kamiazya/whiteboard-loro-adapter'
import { documentIdSchema, nodeIdSchema, workspaceIdSchema } from '@kamiazya/whiteboard-model'
import { z } from 'zod'
import type { ServerDeps } from '../server-deps.js'
import { assertDocumentInWorkspace } from './assert-document-in-workspace.js'
import { loadDocument, saveDocumentSnapshot } from './document-io.js'
import { NodeNotFoundError } from './errors.js'

/**
 * Lock/unlock is the ONE mutation a locked node still accepts (user
 * decision 2026-08-09): a lock an agent cannot lift would need a human at
 * the keyboard to undo an agent's own mistake.
 *
 * The lock itself is editor state, not canvas content — it lives in the
 * doc's sidecar map (see crdt's `setNodeLock`), so it is
 * durable and syncs to peers, yet never appears in an export, a render,
 * or a JSON Canvas file.
 */
export const nodeLockInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    documentId: documentIdSchema,
    nodeId: nodeIdSchema,
    locked: z.boolean(),
  })
  .strict()
export type NodeLockInput = z.infer<typeof nodeLockInputSchema>

export const nodeLockOutputSchema = z
  .object({
    documentId: documentIdSchema,
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
      await assertDocumentInWorkspace(deps.documentIndex, input.workspaceId, input.documentId)
      const { doc, canvas } = await loadDocument(deps, input.documentId)

      // Reject a ghost id rather than storing a lock nothing can ever
      // clear from the UI (the editor only offers unlock on a real node).
      if (!canvas.nodes.some((node) => node.id === input.nodeId)) {
        throw new NodeNotFoundError(input.documentId, input.nodeId)
      }

      setNodeLock(doc, input.nodeId, input.locked)
      await saveDocumentSnapshot(deps, input.documentId, doc)

      return { documentId: input.documentId, nodeId: input.nodeId, locked: input.locked }
    },
  }
}
