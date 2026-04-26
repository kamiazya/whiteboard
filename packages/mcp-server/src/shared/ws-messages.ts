import { z } from 'zod'

// Single source of truth for the JSON text frames that flow over the daemon
// WebSocket. Both the server (packages/mcp-server/src/server/routes/ws.ts) and
// the React client (packages/mcp-server/src/app/hooks/useWhiteboardSync*) use
// these schemas: producers ground their `JSON.stringify(...)` argument on
// `z.infer<typeof xxxMessageSchema>`, consumers use `xxxMessageSchema.safeParse`.

const operatorInfoSchema = z.object({
  kind: z.enum(['ai', 'human', 'system']),
  peerId: z.string().min(1),
  displayName: z.string().optional(),
  agentId: z.string().optional(),
  workspaceId: z.string().optional(),
})

const versionCreatedPayloadSchema = z.object({
  id: z.string(),
  slug: z.string(),
  createdAt: z.string(),
  elementCount: z.number().finite(),
  auto: z.boolean(),
  label: z.string().optional(),
  hasThumbnail: z.boolean(),
  operator: operatorInfoSchema.optional(),
})

export const versionCreatedMessageSchema = z.object({
  type: z.literal('version_created'),
  version: versionCreatedPayloadSchema,
})

export const headChangedMessageSchema = z.object({
  type: z.literal('head_changed'),
  head: z.string().min(1),
})

export const restoreStartedMessageSchema = z.object({
  type: z.literal('restore_started'),
  label: z.string().optional(),
})

export const restoreCompleteMessageSchema = z.object({
  type: z.literal('restore_complete'),
})

export const viewportRequestMessageSchema = z.object({
  type: z.literal('viewport_request'),
  requestId: z.string(),
  mode: z.enum(['fit', 'move']).optional(),
  elementIds: z.array(z.string()).optional(),
  animate: z.boolean().optional(),
  scrollX: z.number().finite().optional(),
  scrollY: z.number().finite().optional(),
  zoom: z.number().finite().optional(),
})

export const exportRequestMessageSchema = z.object({
  type: z.literal('export_request'),
  requestId: z.string(),
  padding: z.number().finite().optional(),
  scale: z.number().finite().optional(),
  minFontPx: z.number().finite().optional(),
  // When set, export only elements inside the frame plus the frame itself, so
  // section-level PNG exports stay small on large canvases.
  frameId: z.string().optional(),
})

// Server → client text frames. Anything else hitting parseServerTextMessage is
// dropped with a warning by the consumer.
export const serverTextMessageSchema = z.discriminatedUnion('type', [
  versionCreatedMessageSchema,
  headChangedMessageSchema,
  restoreStartedMessageSchema,
  restoreCompleteMessageSchema,
  viewportRequestMessageSchema,
  exportRequestMessageSchema,
])

export type OperatorInfo = z.infer<typeof operatorInfoSchema>
export type VersionCreatedPayload = z.infer<typeof versionCreatedPayloadSchema>
export type VersionCreatedMessage = z.infer<typeof versionCreatedMessageSchema>
export type HeadChangedMessage = z.infer<typeof headChangedMessageSchema>
export type RestoreStartedMessage = z.infer<typeof restoreStartedMessageSchema>
export type RestoreCompleteMessage = z.infer<typeof restoreCompleteMessageSchema>
export type ViewportRequestMessage = z.infer<typeof viewportRequestMessageSchema>
export type ExportRequestMessage = z.infer<typeof exportRequestMessageSchema>
export type ServerTextMessage = z.infer<typeof serverTextMessageSchema>
