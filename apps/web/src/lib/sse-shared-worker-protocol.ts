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
])

export const sseWorkerEventSchema = z.discriminatedUnion('type', [
  // Loro update bytes stay base64 here: structured clone could carry the bytes,
  // but keeping the worker's output identical to the wire frame means the
  // decode lives in exactly one place.
  z.object({ type: z.literal('update'), doc: z.string(), update: z.string() }),
  z.object({ type: z.literal('message'), doc: z.string(), raw: z.string() }),
])
