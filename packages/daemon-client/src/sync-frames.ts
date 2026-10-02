import { viewportRequestParamsSchema } from '@kamiazya/whiteboard-server-core/viewport-request'
import { z } from 'zod'
import { operatorInfoAnswerSchema, versionEntryAnswerSchema } from './api-contracts/document.js'

// One schema for a version wherever it travels: the REST listing and this
// broadcast used to carry sibling copies of the same shape, and a field
// added server-side reached whichever one somebody remembered — the wire
// silently dropped it from the other. The server's own VersionEntry type is
// z.infer of `versionEntrySchema`, which this extends only in how a browser
// reads an operator kind it has no word for, so producing a version and
// publishing it cannot disagree.
const versionCreatedPayloadSchema = versionEntryAnswerSchema

export const versionCreatedMessageSchema = z.object({
  type: z.literal('version_created'),
  version: versionCreatedPayloadSchema,
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
  operator: operatorInfoAnswerSchema,
  /** What to highlight. Ids only — the change itself arrives as a Loro update. */
  touched: z.object({
    nodes: z.array(z.string()),
    edges: z.array(z.string()),
  }),
  /** One short line for a toast, e.g. "added 5, tidied the layout". */
  summary: z.string(),
})

// The daemon's stamp plus the params the caller asked for, by their one
// declaration in server-core (which the tool, the port and the HTTP route
// read too). Not strict, like every other frame here: the producer is a
// locally-installed daemon and the consumer an auto-updating page.
export const viewportRequestMessageSchema = z.object({
  type: z.literal('viewport_request'),
  requestId: z.string(),
  ...viewportRequestParamsSchema.shape,
})

export {
  type ViewportRequestParams,
  viewportRequestParamsSchema,
} from '@kamiazya/whiteboard-server-core/viewport-request'

export const serverTextMessageSchema = z.discriminatedUnion('type', [
  versionCreatedMessageSchema,
  restoreStartedMessageSchema,
  restoreCompleteMessageSchema,
  viewportRequestMessageSchema,
  agentActivityMessageSchema,
])

export type VersionCreatedPayload = z.infer<typeof versionCreatedPayloadSchema>
export type VersionCreatedMessage = z.infer<typeof versionCreatedMessageSchema>
export type RestoreStartedMessage = z.infer<typeof restoreStartedMessageSchema>
export type RestoreCompleteMessage = z.infer<typeof restoreCompleteMessageSchema>
export type ViewportRequestMessage = z.infer<typeof viewportRequestMessageSchema>
export type AgentActivityMessage = z.infer<typeof agentActivityMessageSchema>
export type ServerTextMessage = z.infer<typeof serverTextMessageSchema>

// ── Client → Server ──────────────────────────────────────────────────────────

export const clientReadyMessageSchema = z.object({
  type: z.literal('client_ready'),
})

/**
 * Every message a client sends upstream. One member today: the
 * `viewport_response` that acknowledged a `viewport_request` never had a
 * sender, so the route that awaited it answered 504 to every real caller;
 * both went together. Still a discriminated union so the next client message
 * is one more member rather than a new shape.
 */
export const clientTextMessageSchema = z.discriminatedUnion('type', [clientReadyMessageSchema])

export type ClientReadyMessage = z.infer<typeof clientReadyMessageSchema>
export type ClientTextMessage = z.infer<typeof clientTextMessageSchema>
