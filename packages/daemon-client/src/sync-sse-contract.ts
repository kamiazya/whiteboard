/**
 * The SSE sync frame contract, declared once for both ends.
 *
 * These payloads cross a process boundary — the daemon serializes them, a
 * browser tab (or a SharedWorker) parses them — so they are Zod schemas rather
 * than hand-written shapes on each side. Living in daemon-client, which both
 * the daemon's route and the browser's hub import, is what lets the two ends
 * use the same declaration.
 */
import { z } from 'zod'
import { clientTextMessageSchema } from './sync-frames.js'

// These are deliberately NOT `.strict()`, unlike the request DTOs elsewhere in
// this codebase. The producer is a locally-installed daemon and the consumer is
// an auto-updating hosted page, so their versions skew by design. A strict
// parser would make a field added to a frame drop that frame entirely on every
// older client — silently stopping sync — where ignoring the unknown key costs
// nothing. Requests travel the other way and stay strict.

/**
 * The stream's first frame. The id is minted by the daemon and announced here,
 * never chosen by the caller, so holding it is what proves the stream is yours.
 */
export const syncReadyEventSchema = z.object({ streamId: z.string().min(1) })

export type SyncReadyEvent = z.infer<typeof syncReadyEventSchema>

export const syncUpdateEventSchema = z.object({
  doc: z.string().min(1),
  // SSE frames are text, so Loro update bytes travel base64-encoded. Only
  // incremental updates go through here, and only on `workspace:` keys — the
  // state a page starts from is served as binary by
  // GET /api/w/:workspaceId/workspace-document/snapshot, so the largest
  // payload never pays the base64 inflation.
  update: z.string(),
})

export type SyncUpdateEvent = z.infer<typeof syncUpdateEventSchema>

/**
 * A server text message (version_created, restore_started, …) wrapped with the
 * document it belongs to. One SSE stream serves many documents, so an
 * unaddressed frame would be applied to whichever canvas happened to be
 * listening.
 *
 * `raw` stays a string: it is the frame's JSON verbatim, validated by the
 * receiver against the server text-message union.
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
    // Doc keys are `workspace:<id>` (the workspace document, the only key
    // binary frames travel on) or `${handle}/${path}` (one document's text
    // messages), matching the connection registry once the daemon has
    // resolved the handle to an id.
    subscribe: z.array(z.string().min(1)).max(MAX_DOCS_PER_STREAM).optional(),
    unsubscribe: z.array(z.string().min(1)).max(MAX_DOCS_PER_STREAM).optional(),
  })
  .strict()

export type SyncSubscribeRequest = z.infer<typeof syncSubscribeRequestSchema>

/**
 * What a subscribe answers: the documents the stream now follows. The browser
 * hub reads the answer's STATUS as the routing signal — a 2xx routes the
 * documents asked for, anything else refuses them, and a subscribe with no
 * answer at all ends the stream so the next one re-asks — and ignores the
 * body, so the reader that keeps this honest is the route's own test, which
 * parses the real answer through it.
 */
export const syncSubscribeResponseSchema = z
  .object({
    ok: z.literal(true),
    docs: z.array(z.string().min(1)),
  })
  .strict()

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
