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
 * sender brings. No passkey is asked: no keeper pins one (ADR-0050), and
 * the promote contract has no place for an attestation.
 *
 * WHAT TRAVELS BESIDE THE RECORD. Each trash entry's evacuated bytes and the
 * sender's saved versions, posted on in the promote body as they arrived, so
 * a trashed document restores here and the history lists. What this keeper
 * does not report holding afterwards is `leftBehind`, the way a promote
 * reports it.
 *
 * WHAT DOES NOT TRAVEL. Image bytes live in the SENDING browser's file store,
 * outside the record, and this window is at another origin and cannot read
 * it. So the honest report is a COUNT of what the merged record points at —
 * `imagesMissing` — rather than a blob phase that would silently do nothing.
 * Carrying them means the sender posting each one, which is its own
 * increment.
 */
import type { PromoteWorkspaceRequest } from '@kamiazya/whiteboard-daemon-client/api-contracts/promotion'
import { readWorkspaceDocuments } from '@kamiazya/whiteboard-loro-adapter'
import { bytesToBase64Url } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import { getAppLogger } from './app-logger.js'
import { describeTransferFailure, type FailureCopy } from './keeper-transfer-failure.js'
import { type PromoteWording, requestPromote } from './promote-request.js'
import { imagesTheRecordReferences } from './receive-transfer.js'

const log = getAppLogger('accept-transferred-record')

export type AcceptTransferResult =
  | {
      ok: true
      /** Read from the arriving RECORD, so these exact ids resolve here. */
      promotedDocumentIds: string[]
      /** Paths this keeper's own post-merge list reports as contested. */
      shadowedPaths: string[]
      /** What the record points at and this keeper does not have (see the header). */
      imagesMissing: string[]
      /**
       * Of the trash bytes and saved versions the offer carried, what this
       * keeper did not report holding afterwards — its own read-back, never
       * the request echoed.
       */
      leftBehind: string[]
    }
  | { ok: false; reason: string }

export interface AcceptTransferOptions {
  /** A fetch this keeper authorises: same-origin, carrying the session. */
  fetch: typeof globalThis.fetch
  /** The workspace here to merge INTO — a promote merges into an existing one. */
  workspaceId: string
  snapshot: Uint8Array
  /** Each trash entry's evacuated bytes, so the entry restores here. */
  trash?: PromoteWorkspaceRequest['trash']
  /** The sender's saved versions, so the history arrives with the record. */
  versions?: PromoteWorkspaceRequest['versions']
}

export async function acceptTransferredRecord(
  options: AcceptTransferOptions,
): Promise<AcceptTransferResult> {
  try {
    return await acceptUnsafe(options)
  } catch (err) {
    // A thrown fetch or a failure on this side must surface as a sentence the
    // page can show and the sender can be told, never a rejected promise.
    const failure = describeTransferFailure(err, ACCEPT_FAILURE_COPY, {
      log,
      fields: { workspaceId: options.workspaceId },
    })
    // No replica key is involved in a merge this keeper is handed the bytes for.
    return {
      ok: false,
      reason: failure.kind === 'withheld' ? ACCEPT_FAILURE_COPY.device : failure.reason,
    }
  }
}

const ACCEPT_FAILURE_COPY: FailureCopy = {
  network: 'Could not reach this keeper (network error), so the workspace was not merged.',
  unreadable: 'The arriving workspace could not be read here, so it was not merged.',
  device: 'The workspace could not be merged here (unexpected failure).',
  unreadableLog: 'arriving workspace could not be read; merge abandoned',
  deviceLog: 'arriving workspace could not be merged',
}

const KEEPER_WORDING: PromoteWording = {
  subject: 'This keeper',
  object: 'the keeper',
  refused: (status) => `This keeper refused the merge (${status}).`,
  unexpected: 'This keeper answered the merge with an unexpected response.',
}

async function acceptUnsafe(options: AcceptTransferOptions): Promise<AcceptTransferResult> {
  const { fetch, workspaceId, snapshot, trash = [], versions = [] } = options

  const arriving = readArrivingRecord(snapshot)
  if (arriving === null) {
    return { ok: false, reason: 'That does not look like a workspace record.' }
  }
  const { promotedDocumentIds, imagesMissing } = arriving

  const promoted = await requestPromote({
    fetch,
    keeperBaseUrl: '',
    workspaceId,
    snapshot: bytesToBase64Url(snapshot),
    planes: { trash, versions },
    wording: KEEPER_WORDING,
  })
  if (!promoted.ok) return promoted
  return {
    ok: true,
    promotedDocumentIds,
    shadowedPaths: promoted.shadowedPaths,
    imagesMissing,
    leftBehind: promoted.leftBehind,
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
