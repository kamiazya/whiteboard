import {
  documentIdSchema,
  nodeIdSchema,
  workspaceIdSchema,
} from '@kamiazya/whiteboard-canvas-model'
import { setEdgeLock } from '@kamiazya/whiteboard-canvas-workspace'
import { z } from 'zod'
import type { ServerDeps } from '../server-deps.js'
import { assertCanvasInWorkspace } from './assert-canvas-in-workspace.js'
import { loadDocument, saveDocumentSnapshot } from './document-io.js'
import { EdgeNotFoundError } from './errors.js'

/**
 * Edge counterpart to `wb_node_lock`. An edge is its own object here, so its
 * lock is its own entry rather than something derived from whether its
 * endpoints happen to be locked — locking a hub node must not silently
 * freeze every line touching it.
 *
 * Lock/unlock is the ONE mutation a locked edge still accepts, matching
 * `wb_node_lock`: a lock an agent cannot lift would need a human at the
 * keyboard to undo an agent's own mistake.
 */
export const edgeLockInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    documentId: documentIdSchema,
    // canvas-model has no distinct edgeIdSchema — see edge-patch.ts for why
    // reusing nodeIdSchema here is deliberate.
    edgeId: nodeIdSchema,
    locked: z.boolean(),
  })
  .strict()
export type EdgeLockInput = z.infer<typeof edgeLockInputSchema>

export const edgeLockOutputSchema = z
  .object({
    documentId: documentIdSchema,
    edgeId: nodeIdSchema,
    locked: z.boolean(),
  })
  .strict()
export type EdgeLockOutput = z.infer<typeof edgeLockOutputSchema>

export function createEdgeLockTool(deps: ServerDeps) {
  return {
    name: 'wb_edge_lock' as const,
    description: 'Lock or unlock an edge so other clients cannot move or edit it.',
    inputSchema: edgeLockInputSchema,
    outputSchema: edgeLockOutputSchema,
    execute: async (input: EdgeLockInput): Promise<EdgeLockOutput> => {
      await assertCanvasInWorkspace(deps.documentIndex, input.workspaceId, input.documentId)
      const { doc, canvas } = await loadDocument(deps, input.documentId)

      // Reject a ghost id rather than storing a lock nothing can ever
      // clear from the UI (the editor only offers unlock on a real edge).
      if (!canvas.edges.some((edge) => edge.id === input.edgeId)) {
        throw new EdgeNotFoundError(input.documentId, input.edgeId)
      }

      setEdgeLock(doc, input.edgeId, input.locked)
      await saveDocumentSnapshot(deps, input.documentId, doc)

      return { documentId: input.documentId, edgeId: input.edgeId, locked: input.locked }
    },
  }
}
