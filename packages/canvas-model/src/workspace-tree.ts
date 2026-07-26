import { z } from 'zod'
import { canvasIdSchema } from './ids.js'

/**
 * Payload carried by each node of the workspace's Loro movable-tree
 * (this schema models the tree's node data, not the tree container
 * itself). `segment` is a single path segment, so it must not itself
 * contain a path separator.
 */
export const workspaceTreeNodeDataSchema = z.object({
  canvasId: canvasIdSchema,
  segment: z
    .string()
    .min(1)
    .refine((value) => !value.includes('/'), {
      message: 'segment must not contain "/"',
    }),
})

export type WorkspaceTreeNodeData = z.infer<typeof workspaceTreeNodeDataSchema>

/**
 * Workspace-level metadata is deliberately a fully open record with no
 * required keys. Membership/authorization must NOT live here: the tree
 * document syncs to every device with access to the workspace, so putting
 * access-control data in this map would leak it to every peer. Keeping the
 * schema open (rather than picking a fixed shape now) avoids baking that
 * mistake in before the actual authz model is decided.
 */
export const workspaceMetaSchema = z.record(z.string(), z.unknown())

export type WorkspaceMeta = z.infer<typeof workspaceMetaSchema>
