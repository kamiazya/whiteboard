import { workspaceIdSchema } from '@kamiazya/whiteboard-canvas-model'
import { z } from 'zod'
import type { ServerDeps } from '../server-deps.js'
import { reindexWorkspace } from './reindex.js'

export const reindexInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
  })
  .strict()
export type ReindexInput = z.infer<typeof reindexInputSchema>

export const reindexOutputSchema = z
  .object({
    reindexed: z.boolean(),
    canvasCount: z.number().int().min(0),
  })
  .strict()
export type ReindexOutput = z.infer<typeof reindexOutputSchema>

/**
 * Manual full-workspace reindex tool. Every mutation tool already triggers
 * `reindexWorkspace` as part of its own save, so this is a recovery/repair
 * lever — rebuilding WorkspaceIndex rows from scratch after e.g. restoring
 * a workspace-tree snapshot out of band or suspecting index drift — not
 * part of the normal write path.
 */
export function createReindexTool(deps: ServerDeps) {
  return {
    name: 'reindex' as const,
    inputSchema: reindexInputSchema,
    outputSchema: reindexOutputSchema,
    async execute(input: ReindexInput): Promise<ReindexOutput> {
      const canvasCount = await reindexWorkspace(deps, input.workspaceId)
      return { reindexed: true, canvasCount }
    },
  }
}
