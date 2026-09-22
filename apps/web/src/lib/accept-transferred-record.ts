/**
 * Merging an ARRIVING workspace record into a workspace this keeper holds,
 * same-origin.
 *
 * The sibling of `promote-workspace.ts` and deliberately not a parameter on
 * it: that function's first act is opening this browser's own IndexedDB to
 * read a record, and a receiver has no record to read — it was handed the
 * bytes. Threading an "or use these bytes instead" option through it would
 * make the local read conditional on a flag, which is the shape that lets a
 * caller get it wrong silently.
 *
 * WHO SIGNS, AND WHY IT IS THIS SIDE. Decision 3 (user, 2026-09-22) requires
 * a passkey on a transfer to a keeper the person does not own, and in this
 * flow the passkey is THIS origin's. That is the point of the popup: WebAuthn
 * binds a credential to an origin, so a credential registered against the
 * keeper's real domain is asked for and answered at that domain — where the
 * rpId cannot be claimed by another process the way a loopback host's can
 * (ADR-0039). A sender's own credential would be one this keeper has never
 * pinned and could not verify.
 *
 * WHAT DOES NOT TRAVEL. Image bytes live in the SENDING browser's file store,
 * outside the record, and this window is at another origin and cannot read
 * it. So the honest report is a COUNT of what the merged record points at —
 * `imagesMissing` — rather than a blob phase that would silently do nothing.
 * Carrying them means the sender posting each one, which is its own
 * increment.
 */
import {
  type Attestation,
  apiErrorReason,
  promoteWorkspaceResponseSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import { readWorkspaceDocuments } from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc } from 'loro-crdt'
import { listDocuments } from './daemon-api-client.js'
import { attestPromotion, type PasskeyCredentials } from './passkey-attestation.js'
import { imagesTheRecordReferences } from './receive-transfer.js'

export type AcceptTransferResult =
  | {
      ok: true
      /** Read from the arriving RECORD, so these exact ids resolve here. */
      promotedDocumentIds: string[]
      /** Paths this keeper's own post-merge list reports as contested. */
      shadowedPaths: string[]
      /** Whether this keeper verified the assertion sent beside the bytes. */
      attested: boolean
      /** What the record points at and this keeper does not have (see the header). */
      imagesMissing: string[]
    }
  | { ok: false; reason: string }

export interface AcceptTransferOptions {
  fetch: typeof globalThis.fetch
  /** The keeper's own token, R3-injected into the page it served. */
  daemonToken: string
  /** The workspace here to merge INTO — a promote merges into an existing one. */
  workspaceId: string
  snapshot: Uint8Array
  /** Test seams; production reads this origin and the real authenticator. */
  origin?: string
  credentials?: PasskeyCredentials
}

export async function acceptTransferredRecord(
  options: AcceptTransferOptions,
): Promise<AcceptTransferResult> {
  try {
    return await acceptUnsafe(options)
  } catch {
    // A thrown fetch or an unreadable snapshot must surface as a sentence
    // the page can show and the sender can be told, never a rejected promise.
    return { ok: false, reason: 'The workspace could not be merged here (unexpected failure).' }
  }
}

async function acceptUnsafe(options: AcceptTransferOptions): Promise<AcceptTransferResult> {
  const { fetch, daemonToken, workspaceId, snapshot } = options
  const origin = options.origin ?? globalThis.location.origin

  const arriving = readArrivingRecord(snapshot)
  if (arriving === null) {
    return { ok: false, reason: 'That does not look like a workspace record.' }
  }
  const { promotedDocumentIds, imagesMissing } = arriving

  const evidence = await evidenceFromThisOrigin(options, origin)
  if (!evidence.ok) return { ok: false, reason: evidence.reason }

  const res = await fetch(`/api/w/${encodeURIComponent(workspaceId)}/workspace-document/promote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${daemonToken}` },
    body: JSON.stringify({
      snapshot: bytesToBase64Url(snapshot),
      attestation: evidence.attestation,
    }),
  })
  if (!res.ok) {
    return { ok: false, reason: await failureReason(res) }
  }
  const promoted = promoteWorkspaceResponseSchema.safeParse(await res.json().catch(() => null))
  if (!promoted.success) {
    return { ok: false, reason: 'This keeper answered the merge with an unexpected response.' }
  }

  // Collisions are this keeper's own projection — what the target already
  // held is not something the arriving bytes can say. A failed read-back
  // degrades to "none reported", never to a failed merge: it landed.
  const shadowedPaths = await listDocuments(fetch, '', workspaceId)
    .then((response) =>
      response.documents.filter((entry) => entry.shadowed === true).map((entry) => entry.path),
    )
    .catch(() => [])

  return {
    ok: true,
    promotedDocumentIds,
    shadowedPaths,
    attested: promoted.data.attested,
    imagesMissing,
  }
}

/**
 * What the arriving BYTES say about themselves: the document ids they carry
 * and the images they point at. Read from the record rather than from the
 * sender's claims or echoed back from the merge, because identity
 * preservation means these exact ids resolve here afterwards.
 */
function readArrivingRecord(
  snapshot: Uint8Array,
): { promotedDocumentIds: string[]; imagesMissing: string[] } | null {
  const record = new LoroDoc()
  try {
    record.import(snapshot)
  } catch {
    return null
  }
  return {
    promotedDocumentIds: readWorkspaceDocuments(record).map((entry) => entry.documentId),
    imagesMissing: imagesTheRecordReferences(record),
  }
}

/**
 * This keeper's own evidence, or why the merge cannot go ahead. Every
 * failing answer is a refusal: a transfer from another app is confirmed with
 * a passkey registered HERE, so none registered is as much a stop as a
 * declined prompt.
 *
 * Its sibling is `promote-workspace.ts`'s `evidenceFor`, which maps the same
 * three outcomes to the SENDER's sentences. The branch is six lines and every
 * sentence differs — one function with the verb parameterised would be harder
 * to read than two that each say what they mean.
 */
async function evidenceFromThisOrigin(
  options: AcceptTransferOptions,
  origin: string,
): Promise<{ ok: true; attestation: Attestation } | { ok: false; reason: string }> {
  const attested = await attestPromotion({
    daemonBaseUrl: origin,
    workspaceId: options.workspaceId,
    snapshot: options.snapshot,
    ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
  })
  if (attested === null) {
    return {
      ok: false,
      reason:
        'Register a passkey for this keeper first: accepting a workspace from another app is confirmed with one.',
    }
  }
  if (attested.ok) return { ok: true, attestation: attested.attestation }
  return {
    ok: false,
    reason:
      attested.reason === 'cancelled'
        ? 'The passkey prompt was cancelled, so nothing was merged.'
        : 'The passkey could not sign this transfer, so nothing was merged.',
  }
}

async function failureReason(res: Response): Promise<string> {
  try {
    const reason = apiErrorReason(await res.json())
    if (reason !== undefined) return reason
  } catch {
    // fall through to the generic message
  }
  return `This keeper refused the merge (${res.status}).`
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}
