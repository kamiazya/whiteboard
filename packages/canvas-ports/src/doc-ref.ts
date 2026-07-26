import { canvasIdSchema, workspaceIdSchema } from '@kamiazya/whiteboard-canvas-model'
import { z } from 'zod'

/**
 * A DocRef identifies which sync-able document a store/sync operation
 * targets. Two kinds exist because the OpenCanvas model has exactly two
 * Loro-backed document types: an individual canvas, and the single
 * workspace-tree document. Adding a third document type extends this
 * union rather than overloading either variant.
 */
export const docRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('canvas'), canvasId: canvasIdSchema }).strict(),
  z.object({ kind: z.literal('workspace-tree'), workspaceId: workspaceIdSchema }).strict(),
])

export type DocRef = z.infer<typeof docRefSchema>
