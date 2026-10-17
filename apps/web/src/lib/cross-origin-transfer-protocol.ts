/**
 * The message contract for transferring a workspace record to a keeper at
 * ANOTHER origin, declared once and imported by both sides.
 *
 * WHY A WINDOW AND NOT A FETCH. A browser transfers directly to a SaaS or a
 * self-hosted keeper with no daemon hop (user decision, 2026-09-22), and the
 * hosted app's `connect-src` names `'self'` and the font catalogue only — an
 * arbitrary https destination cannot be fetched from this origin, and
 * enumerating every self-hosted address a person might run is not a list
 * anyone can keep. A
 * window at the DESTINATION's origin is subject to no such rule: what it
 * fetches, it fetches same-origin.
 *
 * Three properties follow from that choice rather than being added to it, and
 * each is why this is the mechanism instead of a CORS allowance:
 *
 * - **The destination's own sign-in is used at the destination.** A
 *   server-mode keeper's session is a host-only cookie bound to its origin
 *   (ADR-0047), so the merge is authorised by whoever is signed in THERE,
 *   exactly as any other write of theirs is, and the sending origin never
 *   holds that session.
 * - **The person sees where their data is going.** A popup shows the
 *   destination's origin in the URL bar. An invisible cross-origin fetch
 *   shows nothing, and this transfer is the one operation where the
 *   destination is the whole question.
 * - **The confirmation happens at the destination.** The receiving side
 *   decides whether to accept, so the keeper's own rules — its membership,
 *   its capacity, its sign-in — are applied by the side that owns them.
 *
 * WHY A POPUP AND NOT AN IFRAME. The shipped CSP allows `frame-src https:`,
 * so this app may frame others — but it also sets `frame-ancestors 'none'`,
 * so this app refuses to BE framed, and the receiver is this same app served
 * at the keeper's origin. An iframe receiver would be blocked by our own
 * header. `window.open` is not governed by `frame-ancestors`.
 *
 * WHY THE BYTES ARE NOT VALIDATED WITH `instanceof`. A structured clone
 * arrives as a `Uint8Array` from the SENDING realm, and `instanceof` against
 * this realm's constructor answers false for it. `uint8ArrayAnyRealmSchema` is
 * the realm-independent test, and a `z.instanceof(Uint8Array)` here would
 * refuse every real message while passing every test that builds one in-realm.
 */
import { RECEIVE_TRANSFER_PAGE_PATH } from '@kamiazya/whiteboard-daemon-client/api-contracts/daemon-urls'
import { promoteWorkspaceRequestSchema } from '@kamiazya/whiteboard-daemon-client/api-contracts/promotion'
import { uint8ArrayAnyRealmSchema } from '@kamiazya/whiteboard-model'
import { z } from 'zod'
import { LEFT_BEHIND_MAX_CHARS, LEFT_BEHIND_MAX_ENTRIES } from './user-settings-store.js'

/**
 * Both sides state it, and a mismatch is refused with a reason a person can
 * act on rather than ignored — the two halves of this protocol deploy
 * independently (a hosted app and whatever keeper someone runs), so they
 * WILL be different versions in the field.
 *
 * Bumped when a message's meaning changes, and whenever a REQUIRED field is
 * added to or removed from any message: either way one side's older build
 * refuses the other's message as unreadable, after the transfer may already
 * have landed, where a bump turns that into "update whichever is older"
 * before anything is sent. Never for an added optional field.
 * `cross-origin-transfer-protocol.test.ts` keeps each released version's
 * required keys and fails when the live ones match none. Version 2 dropped
 * the result's `attested`.
 */
export const CROSS_ORIGIN_TRANSFER_PROTOCOL = 2

/**
 * A nonce the SENDER mints per attempt. It is not a secret and does not
 * authorise anything — origin checks do that. What it buys is that a reply
 * belongs to the attempt that asked: a person may have a stale transfer
 * window open, or open two, and a result landing against the wrong attempt
 * would report one transfer's outcome as another's.
 */
const transferNonceSchema = z.string().min(16).max(128)

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
    snapshot: uint8ArrayAnyRealmSchema,
    documentCount: z.number().int().nonnegative(),
    sourceWorkspaceId: z.string().min(1),
    /**
     * The planes the record only points at — each trash entry's evacuated
     * bytes and the saved version rows — in exactly the form the receiver
     * posts on to its keeper's promote, so the two cannot disagree. Optional:
     * an older sender carries none, and its trash then lists unrestorable.
     */
    trash: promoteWorkspaceRequestSchema.shape.trash,
    versions: promoteWorkspaceRequestSchema.shape.versions,
  }),
])

/**
 * What did not land, one sentence each — written by whichever side knows:
 * the sender for what it could not read or fit, the receiver for what its
 * keeper did not report holding. Bounded, since the sender shows it as-is,
 * by the bound the sender's settings keep it under.
 */
const leftBehindSchema = z
  .array(z.string().min(1).max(LEFT_BEHIND_MAX_CHARS))
  .max(LEFT_BEHIND_MAX_ENTRIES)

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
    /**
     * Images the merged record POINTS AT and the destination does not have.
     *
     * Image bytes live in the SENDING browser's own file store, outside the
     * record, and the receiving window is at another origin and cannot read
     * it — so a transfer carries documents and history and not pictures.
     * Reported as a count of what is missing rather than left for someone to
     * discover: a keeper can enumerate what the record references, which is
     * also exactly the list a sender would have to post to carry them.
     *
     * Optional so a receiver that does not compute it is still readable by
     * this version of the sender.
     */
    imagesMissing: z.array(z.string()).optional(),
    /**
     * What the receiving keeper did not report holding of the trash and
     * versions the offer carried. Optional for the reason `imagesMissing` is.
     */
    leftBehind: leftBehindSchema.optional(),
  }),
  z.object({
    type: z.literal('transfer-result'),
    nonce: transferNonceSchema,
    ok: z.literal(false),
    /**
     * A sentence the sender shows as-is. The receiver is the only side that
     * knows why — its capacity, its membership, its sign-in — so it writes
     * the reason rather than sending a code the sender would have to
     * translate without knowing the vocabulary.
     */
    reason: z.string().min(1),
    /**
     * The person at the destination said they did not start this transfer,
     * so the offer was never acted on. Distinct from a keeper refusing: a
     * decline says nothing about the destination's workspaces, its sign-in
     * or its capacity, and must not — the sender may be a page the person
     * never meant to talk to. Optional, so it is not a protocol bump.
     */
    declined: z.literal(true).optional(),
  }),
])

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
  // Trimmed with a loop rather than `/\/+$/`: a greedy quantifier anchored at
  // the end re-tries from every start position when the match fails, which is
  // O(n^2) in a trailing run of slashes. The destination is a value a person
  // can type, so the cheap linear form is the one to write.
  let base = keeperBaseUrl
  while (base.endsWith('/')) base = base.slice(0, -1)
  const params = new URLSearchParams({ from: senderOrigin, nonce })
  return `${base}${RECEIVE_TRANSFER_PAGE_PATH}#${params.toString()}`
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
