import { z } from 'zod'

/**
 * Who saved a version. Declared once, here, because it crosses three
 * boundaries under one shape: the daemon's HTTP save route accepts it, the
 * `version_created` WebSocket message carries it, and the MCP version tools
 * answer with it. `server-core` is the lowest package all three can import.
 */
export const operatorInfoSchema = z.object({
  kind: z.enum(['ai', 'human', 'system']),
  peerId: z.string().min(1),
  displayName: z.string().optional(),
  agentId: z.string().optional(),
  workspaceId: z.string().optional(),
})
export type OperatorInfo = z.infer<typeof operatorInfoSchema>

/**
 * One row of a document's version history, as every surface publishes it —
 * the HTTP list route, the `version_created` broadcast, and the
 * `wb_version_*` tools. The server hydrates missing legacy metadata before
 * answering, so `branchName` is always present on the wire.
 */
export const versionEntrySchema = z.object({
  id: z.string(),
  path: z.string(),
  createdAt: z.string(),
  elementCount: z.number().finite(),
  label: z.string().optional(),
  auto: z.boolean(),
  operator: operatorInfoSchema.optional(),
  hasThumbnail: z.boolean(),
  branchName: z.string(),
})
export type VersionEntry = z.infer<typeof versionEntrySchema>
