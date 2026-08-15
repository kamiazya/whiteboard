/**
 * The tab <-> SharedWorker message contract for the shared SSE stream.
 *
 * Declared once and imported by both sides so the worker and its client cannot
 * drift — a mismatch here fails silently at runtime (a message nobody handles)
 * rather than at build time.
 */
import { z } from 'zod'

export const sseWorkerRequestSchema = z.discriminatedUnion('type', [
  // Sent once per port before any subscribe. The worker cannot obtain the
  // daemon credential itself: it is a pairing session token held by the page.
  z.object({
    type: z.literal('init'),
    baseUrl: z.string().min(1),
    token: z.string().optional(),
  }),
  z.object({ type: z.literal('subscribe'), doc: z.string().min(1) }),
  z.object({ type: z.literal('unsubscribe'), doc: z.string().min(1) }),
  // A client->server control message (client_ready, export_response). It has to
  // travel through the worker because the daemon addresses it by stream, and
  // the stream belongs to the worker rather than to the tab that sends this.
  // The payload is opaque here on purpose: its shape is the daemon's contract
  // (ws-text-message), and re-declaring it would be a second source of truth.
  // Named `control` rather than `message` so it never reads as the mirror of
  // the worker->tab `message` event below, which travels the other way and
  // carries an already-serialized server frame.
  z.object({ type: z.literal('control'), doc: z.string().min(1), message: z.unknown() }),
  // --- authority replica ---
  //
  // The worker keeps a Loro replica of each subscribed document, so the
  // consistency question — what has arrived, in what order — is answered in
  // the same place the daemon stream is read, instead of once per tab.
  //
  // A tab does NOT take this replica as its own doc. It forks from the
  // snapshot, keeping its own peer, and therefore its own undo stack: Loro
  // scopes undo to a peer and refuses to revert another peer's operations, so
  // a shared peer would mean a shared undo. Forks exchange updates with the
  // authority exactly the way the authority exchanges with the daemon, which
  // is what makes tab, worker and daemon one mechanism rather than three.
  z.object({ type: z.literal('snapshot-request'), doc: z.string().min(1) }),
  // A fork's local work, on its way to the authority (and from there to the
  // daemon and the other tabs). Base64 for the same reason the update event
  // below is: one decode site.
  z.object({ type: z.literal('push'), doc: z.string().min(1), update: z.string() }),
])

export const sseWorkerEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message'), doc: z.string(), raw: z.string() }),
  // Whether a stream is currently carrying this document. Addressed like the
  // others so a tab watching several canvases routes it the same way; the
  // worker owns the stream, so this is the only way a tab can know.
  z.object({ type: z.literal('status'), doc: z.string(), connected: z.boolean() }),
  // The authority's current state, for a tab that is forking from it. Answers
  // a snapshot-request; a document the worker has never seen replies with an
  // empty snapshot rather than an error, since forking from empty and letting
  // the daemon fill it in is the same path a first-ever open takes.
  z.object({ type: z.literal('snapshot'), doc: z.string(), snapshot: z.string() }),
  // Authority state a fork has not seen yet. Distinct from `update` (a raw
  // daemon frame relayed verbatim): this one has been through the replica, so
  // it is ordered and deduplicated against everything else the worker knows.
  z.object({ type: z.literal('authority-update'), doc: z.string(), update: z.string() }),
])
