import { errorBody } from '@kamiazya/whiteboard-server-core'
import type { MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'

/**
 * A request body ceiling that answers the daemon's own refusal, `413
 * payload_too_large` in the `{ error, message }` family, built by `errorBody`
 * so the code and the reason cannot swap slots. `noun` names what was too big
 * in the message ("Upload", "Update"), the part a caller reads.
 *
 * The `/mcp` ceiling in `app.ts` is deliberately not this: that endpoint
 * speaks JSON-RPC, and its refusal is an error object with a JSON-RPC code.
 */
export function limitBody(maxSize: number, noun: string): MiddlewareHandler {
  return bodyLimit({
    maxSize,
    onError: (c) =>
      c.json(errorBody('payload_too_large', `${noun} exceeds ${maxSize} bytes limit.`), 413),
  })
}

/**
 * The most a route that takes STORED CONTENT accepts in one request body: an
 * uploaded file, a Loro update for a document, and the same for a workspace's
 * record. A Loro update embeds any attachment-affecting deltas since the
 * client's last sync, so it can approach the largest file an upload may carry;
 * one number keeps the three from drifting apart, each refusing at its own
 * ceiling. Loro thumbnails run around 2 MiB and pasted assets normally fit.
 */
export const CONTENT_BODY_LIMIT_BYTES = 16 * 1024 * 1024

/**
 * The export routes take a small JSON options object (padding, scale, theme,
 * style, outputPath, overwrite), never canvas content — the render is always
 * made server-side from the persisted document. 1 MiB is a generous ceiling
 * for that shape while still bounding an adversarial request.
 */
export const EXPORT_OPTIONS_BODY_LIMIT_BYTES = 1024 * 1024
