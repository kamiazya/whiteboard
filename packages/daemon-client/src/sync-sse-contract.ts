/**
 * The SSE sync frame contract, declared once for both ends.
 *
 * These payloads cross a process boundary — the daemon serializes them, a
 * browser tab (or a SharedWorker) parses them — so they are Zod schemas rather
 * than hand-written shapes on each side. Living in `shared/` is what lets the
 * route that emits them and the hub that consumes them use the same
 * declaration; the hub cannot import from `server/`.
 */
import { z } from 'zod'
import { clientTextMessageSchema } from './ws-messages.js'

/**
 * These are deliberately NOT `.strict()`, unlike the request DTOs elsewhere in
 * this codebase. The producer is a locally-installed daemon and the consumer is
 * an auto-updating hosted page, so their versions skew by design. A strict
 * parser would make a field added to a frame drop that frame entirely on every
 * older client — silently stopping sync — where ignoring the unknown key costs
 * nothing. Requests travel the other way and stay strict.
 */

/**
 * The stream's first frame. The id is minted by the daemon and announced here,
 * never chosen by the caller, so holding it is what proves the stream is yours.
 */
export const syncReadyEventSchema = z.object({ streamId: z.string().min(1) })

export type SyncReadyEvent = z.infer<typeof syncReadyEventSchema>

export const syncUpdateEventSchema = z.object({
  doc: z.string().min(1),
  // SSE frames are text, so Loro update bytes travel base64-encoded. Only
  // incremental updates go through here — the initial snapshot is served as
  // binary by GET /api/w/:workspaceId/document/<path>/snapshot, so the largest
  // payload never pays the base64 inflation.
  update: z.string(),
})

export type SyncUpdateEvent = z.infer<typeof syncUpdateEventSchema>

/**
 * A server text message (version_created, head_changed, …) wrapped with the
 * document it belongs to. A WebSocket is per-canvas so its text frames need no
 * addressing; one SSE stream serves many documents, so an unaddressed frame
 * would be applied to whichever canvas happened to be listening.
 *
 * `raw` stays a string: it is the WebSocket text payload verbatim, validated
 * by the receiver against the same union both transports share.
 */
export const syncMessageEventSchema = z.object({ doc: z.string().min(1), raw: z.string() })

export type SyncMessageEvent = z.infer<typeof syncMessageEventSchema>

// ── Requests: the client -> daemon half ──────────────────────────────────────
//
// Declared beside the frames rather than in the daemon's route, because the
// hub posts these bodies and the route parses them `.strict()`: a field the
// hub renamed or added would answer 400, and the hub swallows a refused
// control message as best-effort — sync would silently stop delivering
// subscriptions or readiness. One declaration is what keeps the two ends
// from drifting that way.

/**
 * How many documents one stream may follow. A real client holds one workspace
 * key plus the documents it has open; the bound is what keeps a caller from
 * making every membership check and every tail pass as long as it likes.
 */
export const MAX_DOCS_PER_STREAM = 256

export const syncSubscribeRequestSchema = z
  .object({
    streamId: z.string().min(1),
    // Doc keys are `${workspaceId}/${path}`, matching the connection registry.
    subscribe: z.array(z.string().min(1)).max(MAX_DOCS_PER_STREAM).optional(),
    unsubscribe: z.array(z.string().min(1)).max(MAX_DOCS_PER_STREAM).optional(),
  })
  .strict()

export type SyncSubscribeRequest = z.infer<typeof syncSubscribeRequestSchema>

/** What a subscribe answers: the documents the stream now follows. */
export const syncSubscribeResponseSchema = z.object({
  ok: z.literal(true),
  docs: z.array(z.string().min(1)),
})

export type SyncSubscribeResponse = z.infer<typeof syncSubscribeResponseSchema>

export const syncClientMessageRequestSchema = z
  .object({
    streamId: z.string().min(1),
    doc: z.string().min(1),
    // The client-message union the browser writes against.
    message: clientTextMessageSchema,
  })
  .strict()

export type SyncClientMessageRequest = z.infer<typeof syncClientMessageRequestSchema>
