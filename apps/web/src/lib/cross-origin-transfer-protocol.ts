/**
 * The message contract for transferring a workspace record to a keeper at
 * ANOTHER origin, declared once and imported by both sides.
 *
 * WHY A WINDOW AND NOT A FETCH. A browser transfers directly to a SaaS or a
 * self-hosted keeper with no daemon hop (user decision, 2026-09-22), and the
 * hosted app's `connect-src` names `'self'` and loopback only — an arbitrary
 * https destination cannot be fetched from this origin, and enumerating every
 * self-hosted address a person might run is not a list anyone can keep. A
 * window at the DESTINATION's origin is subject to no such rule: what it
 * fetches, it fetches same-origin.
 *
 * Three properties follow from that choice rather than being added to it, and
 * each is why this is the mechanism instead of a CORS allowance:
 *
 * - **The destination's own credential is used at the destination.** A
 *   passkey is bound to an origin, so one registered against the keeper's
 *   real domain is asked for, and answered, at that domain. WebAuthn's rpId
 *   drops the port, so a credential registered against a loopback daemon is
 *   offered to whatever else later claims that host (ADR-0039); a real
 *   domain cannot be claimed that way, which is exactly what the crossing
 *   to a keeper the user does not own needs.
 * - **The person sees where their data is going.** A popup shows the
 *   destination's origin in the URL bar. An invisible cross-origin fetch
 *   shows nothing, and this transfer is the one operation where the
 *   destination is the whole question.
 * - **The confirmation happens at the destination.** The receiving side
 *   decides whether to accept, so the keeper's own rules — its membership,
 *   its capacity, its passkey — are applied by the side that owns them.
 *
 * WHY A POPUP AND NOT AN IFRAME. The shipped CSP allows `frame-src https:`,
 * so this app may frame others — but it also sets `frame-ancestors 'none'`,
 * so this app refuses to BE framed, and the receiver is this same app served
 * at the keeper's origin. An iframe receiver would be blocked by our own
 * header. `window.open` is not governed by `frame-ancestors`.
 *
 * WHY THE BYTES ARE NOT VALIDATED WITH `instanceof`. A structured clone
 * arrives as a `Uint8Array` from the SENDING realm, and `instanceof` against
 * this realm's constructor answers false for it. The tag check below is the
 * only reliable test, and a `z.instanceof(Uint8Array)` here would refuse
 * every real message while passing every test that builds one in-realm.
 */
import { z } from 'zod'

/**
 * Bumped when a message's meaning changes, never for an added optional
 * field. Both sides state it, and a mismatch is refused with a reason a
 * person can act on rather than ignored — the two halves of this protocol
 * deploy independently (a hosted app and whatever keeper someone runs), so
 * they WILL be different versions in the field.
 */
export const CROSS_ORIGIN_TRANSFER_PROTOCOL = 1

/** Cross-realm-safe: see the header's note on `instanceof`. */
const transferBytes = z.custom<Uint8Array>(
  (value) => Object.prototype.toString.call(value) === '[object Uint8Array]',
  { message: 'expected the snapshot as a Uint8Array' },
)

/**
 * A nonce the SENDER mints per attempt. It is not a secret and does not
 * authorise anything — origin checks do that. What it buys is that a reply
 * belongs to the attempt that asked: a person may have a stale transfer
 * window open, or open two, and a result landing against the wrong attempt
 * would report one transfer's outcome as another's.
 */
export const transferNonceSchema = z.string().min(16).max(128)

export const transferRequestSchema = z.discriminatedUnion('type', [
  /**
   * Sent by the receiver to its opener once it is listening. The sender
   * cannot post before this: a message posted to a window that has not yet
   * run its script is simply lost, and there is no event for "the other side
   * is ready" other than the other side saying so.
   */
  z.object({
    type: z.literal('transfer-ready'),
    protocol: z.number().int().positive(),
    nonce: transferNonceSchema,
  }),
  /**
   * The sender's offer. `documentCount` and `sourceWorkspaceId` are for the
   * receiver's own confirmation copy — it states what is arriving before a
   * person accepts it, and it must not have to decode the snapshot to do so.
   * They are therefore CLAIMS by the sender, and the receiver reports what it
   * actually merged rather than echoing them.
   */
  z.object({
    type: z.literal('transfer-offer'),
    protocol: z.number().int().positive(),
    nonce: transferNonceSchema,
    snapshot: transferBytes,
    documentCount: z.number().int().nonnegative(),
    sourceWorkspaceId: z.string().min(1),
  }),
])

/**
 * Discriminated on `ok`, not on `type`. Both arms are a `transfer-result` —
 * that is the point of the name — so `type` cannot tell them apart, and Zod
 * says so outright rather than silently taking the first arm: building this
 * union on `type` throws `Duplicate discriminator value`.
 */
export const transferResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    type: z.literal('transfer-result'),
    nonce: transferNonceSchema,
    ok: z.literal(true),
    /** The workspace the receiver merged into, in ITS keeper's namespace. */
    workspaceId: z.string().min(1),
    /** What the receiver really merged — never the sender's claim echoed back. */
    promotedDocumentIds: z.array(z.string()),
    /** Paths the merge left contested; surfaced, never auto-resolved (ADR-0023). */
    shadowedPaths: z.array(z.string()),
    /** Whether the receiving keeper verified a passkey assertion of its own. */
    attested: z.boolean(),
  }),
  z.object({
    type: z.literal('transfer-result'),
    nonce: transferNonceSchema,
    ok: z.literal(false),
    /**
     * A sentence the sender shows as-is. The receiver is the only side that
     * knows why — its capacity, its membership, its passkey — so it writes
     * the reason rather than sending a code the sender would have to
     * translate without knowing the vocabulary.
     */
    reason: z.string().min(1),
  }),
])

export type TransferRequest = z.infer<typeof transferRequestSchema>
export type TransferResponse = z.infer<typeof transferResponseSchema>

/**
 * The receiver needs to know which origin may talk to it BEFORE the first
 * message arrives, so it can refuse every other one — and it cannot learn
 * that from the message, since the message is what is being checked. The
 * sender puts its own origin in the URL it opens, in the FRAGMENT: a
 * fragment is not sent to the server, so the keeper's access log does not
 * accumulate a record of which app sent people to it.
 *
 * It is a HINT and never an authority: the receiver compares it against
 * `event.origin`, which the browser sets and a page cannot forge. A sender
 * that lies here only names an origin its own messages will then fail to
 * match.
 */
export function transferWindowUrl(
  keeperBaseUrl: string,
  { senderOrigin, nonce }: { senderOrigin: string; nonce: string },
): string {
  const base = keeperBaseUrl.replace(/\/+$/, '')
  const params = new URLSearchParams({ from: senderOrigin, nonce })
  return `${base}/receive-transfer#${params.toString()}`
}

/** The other half of `transferWindowUrl`, for the receiver reading its own URL. */
export function parseTransferWindowUrl(
  hash: string,
): { senderOrigin: string; nonce: string } | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  const senderOrigin = params.get('from')
  const nonce = params.get('nonce')
  if (senderOrigin === null || nonce === null) return null
  // An origin, not a URL: anything with a path, query or credentials in it is
  // not what `event.origin` will ever equal, so accepting it would build a
  // comparison that can never succeed.
  let parsed: URL
  try {
    parsed = new URL(senderOrigin)
  } catch {
    return null
  }
  if (parsed.origin !== senderOrigin) return null
  if (!transferNonceSchema.safeParse(nonce).success) return null
  return { senderOrigin, nonce }
}
