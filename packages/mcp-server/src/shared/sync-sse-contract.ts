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
  // binary by GET /api/canvas/:workspaceId/:slug/snapshot, so the largest
  // payload never pays the base64 inflation.
  update: z.string(),
})

export type SyncUpdateEvent = z.infer<typeof syncUpdateEventSchema>

/**
 * A server text message (version_created, head_changed, …) wrapped with the
 * document it belongs to. A WebSocket is per-canvas so its text frames need no
 * addressing; one SSE stream serves many canvases, so an unaddressed frame
 * would be applied to whichever canvas happened to be listening.
 *
 * `raw` stays a string: it is the WebSocket text payload verbatim, validated
 * by the receiver against the same union both transports share.
 */
export const syncMessageEventSchema = z.object({ doc: z.string().min(1), raw: z.string() })

export type SyncMessageEvent = z.infer<typeof syncMessageEventSchema>
