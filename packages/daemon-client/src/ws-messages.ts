import { z } from 'zod'
import { operatorInfoSchema, versionEntrySchema } from './api-contracts/document.js'

// One schema for a version wherever it travels: the REST listing and this
// broadcast used to carry sibling copies of the same shape, and a field
// added server-side reached whichever one somebody remembered — the wire
// silently dropped it from the other. The server's own VersionEntry type is
// z.infer of this same schema (version-store.ts), so producing a version
// and publishing it cannot disagree.
const versionCreatedPayloadSchema = versionEntrySchema

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

/**
 * What an agent just did to this document, for a human watching it.
 *
 * Emitted once per applied `wb_canvas_edit` batch — not as a begin/end pair.
 * A batch is atomic and lands in milliseconds, so a paired form would only
 * flicker, and an `end` lost to a dropped socket would strand the indicator
 * on forever. Presence is instead the client's job: hold "an agent is
 * editing" for a few seconds after the last of these and let it lapse.
 *
 * Never cached for replay (unlike `viewport_request`): this is news, and a
 * tab that connects later should not be told about an edit it already has.
 */
export const agentActivityMessageSchema = z.object({
  type: z.literal('agent_activity'),
  operator: operatorInfoSchema,
  /** What to highlight. Ids only — the change itself arrives as a Loro update. */
  touched: z.object({
    nodes: z.array(z.string()),
    edges: z.array(z.string()),
  }),
  /** One short line for a toast, e.g. "added 5, tidied the layout". */
  summary: z.string(),
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

// The daemon no longer sends this message — canvas export is headless-only
// (see server/routes/export.ts). Kept for apps/web's typechecking until the
// phase that replaces the browser editor removes the last sender.
export const exportRequestMessageSchema = z.object({
  type: z.literal('export_request'),
  requestId: z.string(),
  padding: z.number().finite().optional(),
  scale: z.number().finite().optional(),
  minFontPx: z.number().finite().optional(),
  // When set, export only elements inside the frame plus the frame itself,
  // so section-level PNG exports stay small on large documents.
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
  agentActivityMessageSchema,
])

export type VersionCreatedPayload = z.infer<typeof versionCreatedPayloadSchema>
export type VersionCreatedMessage = z.infer<typeof versionCreatedMessageSchema>
export type HeadChangedMessage = z.infer<typeof headChangedMessageSchema>
export type RestoreStartedMessage = z.infer<typeof restoreStartedMessageSchema>
export type RestoreCompleteMessage = z.infer<typeof restoreCompleteMessageSchema>
export type ViewportRequestMessage = z.infer<typeof viewportRequestMessageSchema>
export type AgentActivityMessage = z.infer<typeof agentActivityMessageSchema>
export type ExportRequestMessage = z.infer<typeof exportRequestMessageSchema>
export type ServerTextMessage = z.infer<typeof serverTextMessageSchema>

// ── Client → Server ──────────────────────────────────────────────────────────

export const clientReadyMessageSchema = z.object({
  type: z.literal('client_ready'),
})

// The daemon no longer awaits this message — canvas export is headless-only
// (see server/routes/export.ts and routes/ws.ts, which treats an incoming
// export_response frame as inert). Kept for apps/web's typechecking until the
// phase that replaces the browser editor removes the last sender.
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
