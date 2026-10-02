/**
 * ADR-0050 decision 1: the hosted page reaches the local daemon only through
 * the whiteboard extension, which relays to a native messaging host, which
 * relays to the daemon's owner-only socket. What crosses is the daemon's
 * existing HTTP API (addendum decision 1) — a request, and a response that
 * arrives as a head, any number of chunks, and an end — so a plain response
 * and an SSE stream are the same shape.
 *
 * The page is the side the host must not trust: the extension admits only
 * the hosted app's origins, and the host still reads every message through
 * `pageToHostSchema` and attaches the daemon's credentials itself.
 */
import { z } from 'zod'
import { BRIDGE_PROTOCOL_VERSION, WINDOW_BRIDGE_CHANNEL } from './extension-names.js'

/**
 * Bytes of body one host message carries. Chromium refuses a message from
 * the host above 1 MB of JSON, and base64 costs a third on top.
 */
export const BRIDGE_CHUNK_BYTES = 512 * 1024

const idSchema = z.string().min(1).max(64)

/**
 * A path the URL parser leaves exactly as written, under `/api/`. Anything it
 * would rewrite — `..`, `%2e%2e`, a second leading slash, a fragment — is a
 * path that reaches somewhere other than it says, so it is refused rather
 * than normalised.
 */
const apiPathSchema = z.string().refine((path) => {
  if (!path.startsWith('/api/')) return false
  const resolved = new URL(path, 'http://localhost')
  return resolved.host === 'localhost' && `${resolved.pathname}${resolved.search}` === path
}, 'must be a path under /api/ that the URL parser leaves unchanged')

export const bridgeMethodSchema = z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'])

export type BridgeMethod = z.infer<typeof bridgeMethodSchema>

export const pageToHostSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('request'),
    id: idSchema,
    method: bridgeMethodSchema,
    path: apiPathSchema,
    headers: z.record(z.string(), z.string()),
    /** base64 */
    body: z.string().optional(),
  }),
  z.object({ type: z.literal('abort'), id: idSchema }),
])
export type PageToHost = z.infer<typeof pageToHostSchema>

export const hostToPageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('head'),
    id: idSchema,
    status: z.number().int().min(100).max(599),
    headers: z.record(z.string(), z.string()),
  }),
  /** base64, at most `BRIDGE_CHUNK_BYTES` decoded */
  z.object({ type: z.literal('chunk'), id: idSchema, data: z.string() }),
  z.object({ type: z.literal('end'), id: idSchema }),
  z.object({
    type: z.literal('error'),
    id: idSchema,
    // Only displayed, so a reason a newer host invents reads as the generic
    // one and its `message` still reaches the person.
    reason: z.enum(['bad-request', 'daemon-unreachable', 'stream-failed']).catch('stream-failed'),
    message: z.string(),
  }),
])
export type HostToPage = z.infer<typeof hostToPageSchema>

/**
 * What the extension itself tells the page: everything the host sent, and
 * that the host is gone — not installed, crashed, or refused by the browser —
 * after which the port is closed.
 */
export const extensionToPageSchema = z.union([
  hostToPageSchema,
  z.object({ type: z.literal('disconnected'), message: z.string() }),
])
export type ExtensionToPage = z.infer<typeof extensionToPageSchema>

/** A one-off message the page sends to learn whether the extension is there. */
export const extensionHelloSchema = z.object({ type: z.literal('hello') })
export type ExtensionHello = z.infer<typeof extensionHelloSchema>
/**
 * What the extension says of itself: its release, and the bridge protocol it
 * speaks. `protocol` is optional only to read an extension built before the
 * field existed — which `bridgeSkew` then reports as the skew it is.
 */
const extensionIdentity = { version: z.string(), protocol: z.number().int().optional() }
export const extensionHelloReplySchema = z.object({
  type: z.literal('hello'),
  ...extensionIdentity,
})
export type ExtensionHelloReply = z.infer<typeof extensionHelloReplySchema>

/**
 * Why a page must not use the extension that answered, or `null` when it
 * speaks the protocol this page does. The words are the whole diagnosis: a
 * skew otherwise shows as requests that fail or never answer.
 */
export function bridgeSkew(identity: {
  version: string
  protocol?: number | undefined
}): string | null {
  if (identity.protocol === BRIDGE_PROTOCOL_VERSION) return null
  const speaks =
    identity.protocol === undefined
      ? 'predates the bridge protocol check'
      : `speaks bridge protocol ${identity.protocol}`
  const remedy =
    identity.protocol !== undefined && identity.protocol > BRIDGE_PROTOCOL_VERSION
      ? 'reload this page to get the matching one'
      : 'update the extension'
  return `the whiteboard extension (version ${identity.version}) ${speaks}, but this page speaks protocol ${BRIDGE_PROTOCOL_VERSION}: ${remedy}`
}

/**
 * Firefox lets no page message an extension, so the extension's content
 * script relays between the page's window and the extension, for ports the
 * page opens by a name of its own. This is what the content script posts;
 * a relayed `message` is read by `extensionToPageSchema`, so it stays
 * `unknown` here.
 */
const fromExtension = { channel: z.literal(WINDOW_BRIDGE_CHANNEL), from: z.literal('extension') }
export const windowFromExtensionSchema = z.discriminatedUnion('kind', [
  z.object({ ...fromExtension, kind: z.literal('hello'), ...extensionIdentity }),
  z.object({ ...fromExtension, kind: z.literal('connected'), port: idSchema }),
  z.object({ ...fromExtension, kind: z.literal('message'), port: idSchema, message: z.unknown() }),
  z.object({ ...fromExtension, kind: z.literal('disconnect'), port: idSchema }),
])
export type WindowFromExtension = z.infer<typeof windowFromExtensionSchema>

/** A window message without the two fields every sender fills in the same way. */
type WithoutEnvelope<M> = M extends M ? Omit<M, 'channel' | 'from'> : never
export type WindowFromExtensionBody = WithoutEnvelope<WindowFromExtension>

/**
 * What the page posts to the content script. The content script reads only
 * the envelope — the host validates each request — so it parses with the
 * schema whose `message` stays `unknown`; the page's own sender is typed by
 * the one that names `pageToHostSchema`.
 */
const fromPage = { channel: z.literal(WINDOW_BRIDGE_CHANNEL), from: z.literal('page') }
function windowFromPage<M extends z.ZodType>(message: M) {
  return z.discriminatedUnion('kind', [
    z.object({ ...fromPage, kind: z.literal('hello') }),
    z.object({ ...fromPage, kind: z.literal('connect'), port: idSchema }),
    z.object({ ...fromPage, kind: z.literal('message'), port: idSchema, message }),
    z.object({ ...fromPage, kind: z.literal('disconnect'), port: idSchema }),
  ])
}
export const windowFromPageSchema = windowFromPage(pageToHostSchema)
export type WindowFromPage = z.infer<typeof windowFromPageSchema>
export type WindowFromPageBody = WithoutEnvelope<WindowFromPage>
export const windowFromPageEnvelopeSchema = windowFromPage(z.unknown())
export type WindowFromPageEnvelope = z.infer<typeof windowFromPageEnvelopeSchema>
