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
])

export const sseWorkerEventSchema = z.discriminatedUnion('type', [
  // Loro update bytes stay base64 here: structured clone could carry the bytes,
  // but keeping the worker's output identical to the wire frame means the
  // decode lives in exactly one place.
  z.object({ type: z.literal('update'), doc: z.string(), update: z.string() }),
  z.object({ type: z.literal('message'), doc: z.string(), raw: z.string() }),
])
