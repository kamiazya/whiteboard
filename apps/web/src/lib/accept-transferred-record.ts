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
 * WHO AUTHORISES IT. The person signed in to THIS keeper, through the
 * session `fetch` carries — the keeper's own authority, not evidence the
 * sender brings. No passkey is asked: no keeper pins one any more
 * (ADR-0050), and every keeper refuses a promote carrying an attestation.
 *
 * WHAT DOES NOT TRAVEL. Image bytes live in the SENDING browser's file store,
 * outside the record, and this window is at another origin and cannot read
 * it. So the honest report is a COUNT of what the merged record points at —
 * `imagesMissing` — rather than a blob phase that would silently do nothing.
 * Carrying them means the sender posting each one, which is its own
 * increment.
 */
import {
  apiErrorReason,
  promoteWorkspaceResponseSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import { readWorkspaceDocuments } from '@kamiazya/whiteboard-loro-adapter'
import { bytesToBase64Url } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import { listDocuments } from './daemon-api-client.js'
import { imagesTheRecordReferences } from './receive-transfer.js'

export type AcceptTransferResult =
  | {
      ok: true
      /** Read from the arriving RECORD, so these exact ids resolve here. */
      promotedDocumentIds: string[]
      /** Paths this keeper's own post-merge list reports as contested. */
      shadowedPaths: string[]
      /** The keeper's own word on attestation — `false` from every keeper today. */
      attested: boolean
      /** What the record points at and this keeper does not have (see the header). */
      imagesMissing: string[]
    }
  | { ok: false; reason: string }

export interface AcceptTransferOptions {
  /** A fetch this keeper authorises: same-origin, carrying the session. */
  fetch: typeof globalThis.fetch
  /** The workspace here to merge INTO — a promote merges into an existing one. */
  workspaceId: string
  snapshot: Uint8Array
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
  const { fetch, workspaceId, snapshot } = options

  const arriving = readArrivingRecord(snapshot)
  if (arriving === null) {
    return { ok: false, reason: 'That does not look like a workspace record.' }
  }
  const { promotedDocumentIds, imagesMissing } = arriving

  const res = await fetch(`/api/w/${encodeURIComponent(workspaceId)}/workspace-document/promote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ snapshot: bytesToBase64Url(snapshot) }),
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

async function failureReason(res: Response): Promise<string> {
  try {
    const reason = apiErrorReason(await res.json())
    if (reason !== undefined) return reason
  } catch {
    // fall through to the generic message
  }
  return `This keeper refused the merge (${res.status}).`
}
