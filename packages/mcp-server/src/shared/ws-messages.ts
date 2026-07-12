import { z } from 'zod'

// Server's VersionEntry / OperatorInfo (in server/store/version-store.ts) is
// the runtime source of truth for these payloads. We don't import that type
// from the `shared/` layer to keep client-only consumers free of server
// modules; instead the server-side compile pass on `tools/canvas.ts` /
// `routes/ws.ts` exercises the equivalence by passing VersionEntry into
// `sendVersionCreated`, which expects a payload that satisfies this schema.

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
  // When set, export only elements inside the frame plus the frame itself,
  // so section-level PNG exports stay small on large canvases.
  frameId: z.string().optional(),
  // Forces the exported scene into 'light' or 'dark' regardless of the
  // connected client's current theme. Must be carried through here too —
  // omitting it from the schema causes the WebSocket parser to silently
  // strip the field, so a forced-theme export_canvas request would render in
  // whatever theme the browser tab happens to be in.
  theme: z.enum(['light', 'dark']).optional(),
})

export const serverTextMessageSchema = z.discriminatedUnion('type', [
  versionCreatedMessageSchema,
  headChangedMessageSchema,
  restoreStartedMessageSchema,
  restoreCompleteMessageSchema,
  viewportRequestMessageSchema,
  exportRequestMessageSchema,
])

export type VersionCreatedPayload = z.infer<typeof versionCreatedPayloadSchema>
export type VersionCreatedMessage = z.infer<typeof versionCreatedMessageSchema>
export type HeadChangedMessage = z.infer<typeof headChangedMessageSchema>
export type RestoreStartedMessage = z.infer<typeof restoreStartedMessageSchema>
export type RestoreCompleteMessage = z.infer<typeof restoreCompleteMessageSchema>
export type ViewportRequestMessage = z.infer<typeof viewportRequestMessageSchema>
export type ExportRequestMessage = z.infer<typeof exportRequestMessageSchema>
export type ServerTextMessage = z.infer<typeof serverTextMessageSchema>

// ── Client → Server ──────────────────────────────────────────────────────────

export const clientReadyMessageSchema = z.object({
  type: z.literal('client_ready'),
})

export const exportResponseMessageSchema = z.object({
  type: z.literal('export_response'),
  requestId: z.string(),
  data: z.string(),
})

export const viewportResponseMessageSchema = z.object({
  type: z.literal('viewport_response'),
  requestId: z.string(),
})

// W3C `traceparent` carrier sent ahead of a binary Loro update so the
// server can parent its `ws.message.binary` span on the client's active
// span. Validated as `00-<32hex>-<16hex>-<2hex>` to match the W3C
// trace-context spec; invalid values are dropped silently with a warning.
export const wsTraceMessageSchema = z.object({
  type: z.literal('ws_trace'),
  traceparent: z.string().regex(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/),
  // Optional W3C tracestate string. Pass-through for vendor-specific
  // sampling decisions; the server forwards it to the propagator without
  // interpretation.
  tracestate: z.string().optional(),
})

export const clientTextMessageSchema = z.discriminatedUnion('type', [
  clientReadyMessageSchema,
  exportResponseMessageSchema,
  viewportResponseMessageSchema,
  wsTraceMessageSchema,
])

export type ClientReadyMessage = z.infer<typeof clientReadyMessageSchema>
export type ExportResponseMessage = z.infer<typeof exportResponseMessageSchema>
export type ViewportResponseMessage = z.infer<typeof viewportResponseMessageSchema>
export type WsTraceMessage = z.infer<typeof wsTraceMessageSchema>
export type ClientTextMessage = z.infer<typeof clientTextMessageSchema>
