/**
 * The receiving half of a cross-origin workspace transfer: what this window
 * will act on, and what it does with the bytes once it has them.
 *
 * This runs at the DESTINATION keeper's origin. `mcp-server` already serves
 * this app from the built dist, so a self-hosted keeper serves this page at
 * its own address without anything new being deployed — which is also what
 * makes the passkey work, since WebAuthn here uses this origin's rpId rather
 * than the sender's.
 *
 * THE GATE IS THE WHOLE SECURITY STORY, and it is ordered deliberately:
 *
 * 1. **Origin decides whether the conversation is this session's at all.**
 *    Any page holding a handle to this window can `postMessage` to it, so a
 *    message from elsewhere is IGNORED rather than refused — refusing
 *    visibly would let any origin raise an error on this page, about
 *    something the person reading it cannot act on. `event.origin` is set by
 *    the browser and a page cannot forge it, which is why the check is there
 *    and never on the body.
 * 2. **Shape decides whether it is an offer.** A window receives plenty of
 *    traffic nobody asked for — extensions, dev tooling, frameworks — and
 *    none of it is an error.
 * 3. **Nonce and protocol decide whether THIS offer is usable.** Those are
 *    refusals, because at that point the message is addressed here and the
 *    person is waiting on it.
 *
 * Getting that order wrong is not a visible bug: parsing the body first
 * would report a malformed-message error for traffic that was never this
 * session's, in words about the wrong thing.
 */
import {
  collectImageRefIds,
  documentContainers,
  readWorkspaceDocuments,
} from '@kamiazya/whiteboard-loro-adapter'
import {
  CROSS_ORIGIN_TRANSFER_PROTOCOL,
  parseTransferWindowUrl,
  type TransferResponse,
  transferRequestSchema,
} from './cross-origin-transfer-protocol.js'

/**
 * What this window learned from its own URL: who may talk to it, and which
 * attempt it belongs to. Established BEFORE the first message arrives,
 * because the message is what is being checked.
 */
export interface TransferSession {
  senderOrigin: string
  nonce: string
}

/** Null when the fragment names no sender or no usable nonce — the page then has nothing to talk to. */
export function openTransferSession(hash: string): TransferSession | null {
  return parseTransferWindowUrl(hash)
}

export type OfferedTransfer =
  | {
      kind: 'offer'
      snapshot: Uint8Array
      /** The sender's CLAIM about what is arriving, for the confirmation copy. */
      documentCount: number
      /** Likewise a claim: the receiver reports what it really merged. */
      sourceWorkspaceId: string
    }
  /** Not this session's business; nothing is shown. */
  | { kind: 'ignored' }
  /** Addressed here and unusable — the person is waiting, so say why. */
  | { kind: 'refused'; reason: string }

/** The shape of a `MessageEvent` this reads, so a test needs no real event. */
export interface ArrivingMessage {
  origin: string
  data: unknown
}

export function readOfferedTransfer(
  session: TransferSession,
  message: ArrivingMessage,
): OfferedTransfer {
  // 1. Origin first — see the header. Never parse before this.
  if (message.origin !== session.senderOrigin) return { kind: 'ignored' }

  // 2. Is it even an offer? Anything else from this origin is still traffic
  //    nobody asked about.
  const data = message.data
  if (typeof data !== 'object' || data === null) return { kind: 'ignored' }
  if ((data as { type?: unknown }).type !== 'transfer-offer') return { kind: 'ignored' }

  // 3. From here on it IS an offer addressed to this session, so every exit
  //    is a refusal with a sentence.
  const parsed = transferRequestSchema.safeParse(data)
  if (!parsed.success || parsed.data.type !== 'transfer-offer') {
    return { kind: 'refused', reason: 'The transfer offer could not be read.' }
  }
  const offer = parsed.data
  if (offer.nonce !== session.nonce) {
    return {
      kind: 'refused',
      reason: 'That offer belongs to a different transfer attempt, so nothing was accepted.',
    }
  }
  if (offer.protocol !== CROSS_ORIGIN_TRANSFER_PROTOCOL) {
    // Both versions, because the two halves deploy independently and the
    // person has to know WHICH side to update.
    return {
      kind: 'refused',
      reason: `The sender speaks transfer protocol ${offer.protocol} and this keeper speaks ${CROSS_ORIGIN_TRANSFER_PROTOCOL}. Update whichever is older and try again.`,
    }
  }
  return {
    kind: 'offer',
    snapshot: offer.snapshot,
    documentCount: offer.documentCount,
    sourceWorkspaceId: offer.sourceWorkspaceId,
  }
}

/**
 * The images a merged record POINTS AT. They do not travel with it: image
 * bytes live in the SENDER's own file store, outside the record, and this
 * window is at another origin and cannot read that store.
 *
 * So the honest thing a receiver can do is COUNT them and say so. The walk
 * is `collectImageRefIds`, shared with the daemon-side GC's live-state pass,
 * so the two sides cannot disagree about what counts as a live reference.
 */
export function imagesTheRecordReferences(
  record: Parameters<typeof readWorkspaceDocuments>[0],
): string[] {
  const refs = new Set<string>()
  for (const entry of readWorkspaceDocuments(record)) {
    if (entry.kind !== 'spatial') continue
    for (const fileId of collectImageRefIds(documentContainers(record, entry.documentId))) {
      refs.add(fileId)
    }
  }
  return [...refs]
}

/** The reply this window posts back to its opener, addressed to that exact origin. */
export function postTransferResult(
  target: { postMessage: (message: unknown, targetOrigin: string) => void },
  session: TransferSession,
  result:
    | Omit<Extract<TransferResponse, { ok: true }>, 'type' | 'nonce'>
    | { ok: false; reason: string },
): void {
  // Addressed to the sender's origin rather than '*': a reply says what
  // landed in somebody's workspace, and '*' would hand it to whatever
  // happens to be at the other end.
  target.postMessage(
    { type: 'transfer-result', nonce: session.nonce, ...result },
    session.senderOrigin,
  )
}
