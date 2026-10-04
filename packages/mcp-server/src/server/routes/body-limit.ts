import { MAX_FILE_UPLOAD_BYTES } from '@kamiazya/whiteboard-daemon-client/api-contracts/files'
import { errorBody } from '@kamiazya/whiteboard-server-core'
import type { Context, MiddlewareHandler } from 'hono'

/**
 * The 413 a body past its ceiling is answered with: the daemon's own refusal,
 * `payload_too_large` in the `{ error, message }` family, built by `errorBody`
 * so the code and the reason cannot swap slots. `noun` names what was too big
 * in the message ("Upload", "Update"), the part a caller reads.
 */
function payloadTooLarge(c: Context, maxSize: number, noun: string): Response {
  return c.json(errorBody('payload_too_large', `${noun} exceeds ${maxSize} bytes limit.`), 413)
}

/** The bytes of `body` unless it runs past `maxSize`, which stops the read at the first chunk that does. */
async function readWithin(
  body: ReadableStream<Uint8Array>,
  maxSize: number,
): Promise<Uint8Array | undefined> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > maxSize) {
      // Not awaited: on a branch of a tee the promise settles only once the
      // other branch is cancelled too, which the caller does next.
      reader.cancel().catch(() => {})
      return undefined
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.length
  }
  return bytes
}

/** A body whose declared length is already past the ceiling needs no read to be refused. */
function declaresMoreThan(c: Context, maxSize: number): boolean {
  const { headers } = c.req.raw
  if (headers.has('transfer-encoding')) return false
  const declared = headers.get('content-length')
  return declared !== null && Number.parseInt(declared, 10) > maxSize
}

/**
 * A request body ceiling, as middleware.
 *
 * The body is counted on a CLONE, so the handler is handed the very Request it
 * was given. Hono's own `bodyLimit` rebuilds the Request to re-supply what it
 * consumed, and server mode memoises the grant that authenticated a request
 * against that object (`membership-gate.ts`): after the rebuild a handler
 * asking who is calling is answered "nobody".
 *
 * The `/mcp` ceiling in `app.ts` is deliberately not this: that endpoint
 * speaks JSON-RPC, and its refusal is an error object with a JSON-RPC code.
 */
export function limitBody(maxSize: number, noun: string): MiddlewareHandler {
  return async (c, next) => {
    if (declaresMoreThan(c, maxSize)) return payloadTooLarge(c, maxSize, noun)
    // A declared length inside the ceiling is the transport's to enforce; only a
    // body that declares none (chunked) has to be counted.
    if (c.req.raw.body === null || c.req.raw.headers.has('content-length')) return next()
    const counted = await readWithin(c.req.raw.clone().body as ReadableStream<Uint8Array>, maxSize)
    if (counted === undefined) {
      c.req.raw.body.cancel().catch(() => {})
      return payloadTooLarge(c, maxSize, noun)
    }
    return next()
  }
}

/**
 * The most a JSON request body may carry unless its route says otherwise.
 *
 * Every body the daemon reads is a handful of fields: names, a path, a version
 * label, a role, a sync subscription — the largest legitimate one is a few
 * kilobytes — so a megabyte is generous by three orders of magnitude while
 * still stopping a request that would otherwise be buffered whole and, past
 * that, stored. A route that carries stored content or a document snapshot
 * asks for more by name (`CONTENT_BODY_LIMIT_BYTES`, workspace promotion's
 * own) rather than inheriting a number sized for a label.
 */
export const JSON_BODY_LIMIT_BYTES = 1024 * 1024

/**
 * The most a route that takes STORED CONTENT accepts in one request body: an
 * uploaded file, a Loro update for a document, and the same for a workspace's
 * record. A Loro update embeds any attachment-affecting deltas since the
 * client's last sync, so it can approach the largest file an upload may carry;
 * one number keeps the three from drifting apart, each refusing at its own
 * ceiling. The number itself is the per-file ceiling the editor checks a pick
 * against (`api-contracts/files`), so the browser and the daemon refuse the
 * same file. Loro thumbnails run around 2 MiB and pasted assets normally fit.
 */
export const CONTENT_BODY_LIMIT_BYTES = MAX_FILE_UPLOAD_BYTES

/**
 * The export routes take a small JSON options object (padding, scale, theme,
 * style, outputPath, overwrite), never canvas content — the render is always
 * made server-side from the persisted document. 1 MiB is a generous ceiling
 * for that shape while still bounding an adversarial request.
 */
export const EXPORT_OPTIONS_BODY_LIMIT_BYTES = 1024 * 1024

/**
 * A request body's text, or the 413 that refuses one past `maxSize`.
 *
 * For a route that reads its own JSON, where a middleware would have to be
 * remembered beside every handler. The body is consumed here, once, and the
 * ceiling holds as it is READ, so a request that declares no
 * `Content-Length` (chunked) is stopped at `maxSize` bytes instead of buffered whole.
 */
export async function readTextWithin(
  c: Context,
  maxSize: number,
  noun: string,
): Promise<{ text: string } | { refusal: Response }> {
  if (declaresMoreThan(c, maxSize)) return { refusal: payloadTooLarge(c, maxSize, noun) }
  const { body } = c.req.raw
  if (body === null) return { text: '' }
  const bytes = await readWithin(body, maxSize)
  if (bytes === undefined) return { refusal: payloadTooLarge(c, maxSize, noun) }
  return { text: new TextDecoder().decode(bytes) }
}

/** `POST …/documents` creates a document from the content it carries, so it takes the content ceiling. */
const V1_DOCUMENT_CREATE = /^\/api\/v1\/workspaces\/[^/]+\/documents$/

/**
 * The ceiling on a body `/api/v1` reads, as one middleware over the mount.
 *
 * `/api/v1` is served from server-core, a shared layer that reads each body
 * itself and cannot name this daemon's refusal; the daemon's own answer is
 * put in front of it here. Everything is a few fields except the one route
 * that creates a document from content.
 */
export function limitV1WriteBody(): MiddlewareHandler {
  const fields = limitBody(JSON_BODY_LIMIT_BYTES, 'Request body')
  const content = limitBody(CONTENT_BODY_LIMIT_BYTES, 'Request body')
  return (c, next) =>
    c.req.method === 'POST' && V1_DOCUMENT_CREATE.test(c.req.path)
      ? content(c, next)
      : fields(c, next)
}
