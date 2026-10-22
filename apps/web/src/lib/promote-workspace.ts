/**
 * Promotion (ADR-0023): the browser keeper's whole workspace record moved
 * into a workspace of the daemon on this machine, identity and history
 * intact. Settings > Connections' "This workspace" section
 * (`PromoteWorkspaceSection`) is the caller, and it loads this module lazily:
 * it reaches loro-crdt, which stays out of the entry closure
 * (entry-graph-loro-free.test.ts guards it).
 *
 * The destination is a parameter, `keeperBaseUrl`, named for the keeper axis
 * rather than for the daemon: nothing in the transfer is daemon-shaped, and
 * the daemon is the one keeper the section offers today. The sentences a
 * person reads name the daemon, because that is who they moved to.
 *
 * The core move is a CRDT merge of the record's snapshot through the
 * daemon's promote route, which imports these bytes the way its sync surface
 * would and writes one explicit human checkpoint per promoted document.
 * Beside the record travel the planes it only points at — each trash entry's
 * evacuated bytes and the saved version rows (`carried-planes.ts`) — and
 * every image any of them names, uploaded afterwards one file at a time.
 *
 * No passkey assertion travels with it: the daemon on this machine has one
 * person — the owner who alone can reach its socket (ADR-0050 decision 3) —
 * so there is nobody for an assertion to tell apart. A transfer to a keeper
 * the person does NOT own goes through `accept-transferred-record.ts`, at
 * that keeper's own origin.
 *
 * The caller owns the fold: a legacy row-plane document that has not been
 * absorbed into the tree yet is not in the record this reads, so the promote
 * surface must run after the startup fold (any FoldingBrowserIndex read
 * performs it; the Settings section folds explicitly before counting, since
 * it can be a session's first surface) — the same ordering every other
 * record consumer relies on.
 */

import { documentFileApiUrl } from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import {
  collectImageRefIds,
  documentContainers,
  readTrashEntries,
  readWorkspaceDocuments,
} from '@kamiazya/whiteboard-loro-adapter'
import { bytesToBase64Url, newImageRef } from '@kamiazya/whiteboard-model'
import type { WorkspaceDocs } from '@kamiazya/whiteboard-workspace-index'
import type { LoroDoc } from 'loro-crdt'
import { getAppLogger } from './app-logger.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import {
  type CarriedPlanes,
  type FittedPlanes,
  fitCarriedPlanes,
  readCarriedPlanes,
  versionsWithinJudgedBudget,
} from './carried-planes.js'
import { countOf } from './count-wording.js'
import { putDaemonImage } from './daemon-file-adapter.js'
import { DocumentFileStore } from './document-file-store.js'
import { imageRefusal } from './image-upload-policy.js'
import { describeTransferFailure, errorName, type FailureCopy } from './keeper-transfer-failure.js'
import {
  type PromoteRequestOptions,
  type PromoteRequestResult,
  type PromoteWording,
  requestPromote,
} from './promote-request.js'

const log = getAppLogger('promote-workspace')

export interface PromoteWorkspaceOptions {
  fetch: typeof globalThis.fetch
  keeperBaseUrl: string
  /** The TARGET workspace at that keeper — promotion merges into an existing one. */
  workspaceId: string
  /** The browser keeper's records (production: `new BrowserWorkspaceDocs()`). */
  workspaceDocs: WorkspaceDocs
  /**
   * Called as each real phase starts — 'record' before the CRDT merge POST,
   * 'blobs' before the image uploads. The progress UI narrates from these
   * instead of inventing a timeline.
   */
  onProgress?: (phase: 'record' | 'blobs') => void
}

/**
 * How many documents a promotion would move, read from the same record the
 * transfer reads — the confirmation dialog's number, computed before any
 * request leaves the browser. 0 both for an empty record and for no record.
 */
export async function countBrowserWorkspaceDocuments(
  workspaceDocs: WorkspaceDocs,
): Promise<number> {
  const record = await workspaceDocs.open(getBrowserWorkspaceId())
  if (record === null) return 0
  return readWorkspaceDocuments(record).length
}

export type PromoteWorkspaceResult =
  | {
      kind: 'ok'
      /**
       * The browser workspace the record was read from — what a per-workspace
       * moved marker needs, reported by the transfer itself rather than
       * re-read by the caller, so the two cannot disagree.
       */
      sourceWorkspaceId: string
      /** Every documentId the record carried across — the same ids, by design. */
      promotedDocumentIds: string[]
      /** Paths the merge left contested; surfaced, never auto-resolved. */
      shadowedPaths: string[]
      /**
       * Image bytes live OUTSIDE the record (the content-addressed file
       * store), so each referenced image travels separately through the
       * daemon's file route. Per-file outcomes, because one unreadable image
       * must not fail — or silently hollow out — the whole promotion:
       * `missing` are references this browser holds no readable bytes for —
       * already gone, or a record too corrupt to read (the promoted document
       * was equally broken before); `failed` are images this browser could
       * not read, or uploads the daemon refused or the network dropped, each
       * with the reason. A type or size the daemon will never store stays
       * failed on every re-run, while a dropped connection is cured by one
       * (the whole promotion is an idempotent merge).
       */
      blobs: {
        transferred: string[]
        missing: string[]
        failed: Array<{ fileId: string; reason: string }>
      }
      /**
       * What this browser keeps that the keeper did not verifiably take —
       * trash an entry's bytes could not come with, saved versions, a part
       * of the record no reader could judge — one sentence per cause. The
       * browser copy is the only one of these, so it must stay while any is
       * listed.
       */
      leftBehind: string[]
      /**
       * How many saved versions this browser holds that the move did not
       * carry — past the most one move carries, or past what the keeper
       * would check in one move. Each is also named in `leftBehind`.
       */
      versionsLeftBehind: number
    }
  | { kind: 'failed'; reason: string }

const DAEMON_WORDING: PromoteWording = {
  subject: 'The daemon',
  object: 'the daemon',
  refused: (status) => `Request failed (${status}).`,
  unexpected: 'The daemon answered the move with an unexpected response.',
}

const PROMOTE_FAILURE_COPY: FailureCopy = {
  network: 'Could not reach the destination (network error).',
  unreadable: "This browser's copy of this workspace could not be read, so it was not moved.",
  device: 'This workspace could not be prepared on this device to move it.',
  unreadableLog: 'stored workspace could not be read; promote abandoned',
  deviceLog: 'workspace promote failed on this device',
}

export async function promoteWorkspace(
  options: PromoteWorkspaceOptions,
): Promise<PromoteWorkspaceResult> {
  try {
    return await promoteWorkspaceUnsafe(options)
  } catch (err) {
    // Anything thrown must surface as a structured failure the confirmation
    // UI can show, never a rejected promise. The transfer itself is safe to
    // re-run: the same snapshot re-POSTed is an idempotent merge.
    const failure = describeTransferFailure(err, PROMOTE_FAILURE_COPY, {
      log,
      fields: { keeperBaseUrl: options.keeperBaseUrl, workspaceId: options.workspaceId },
    })
    // A withheld replica key is a sealed replica's failure; the browser
    // keeper's own record is read without one, so it reads as unreadable.
    return failure.kind === 'withheld'
      ? { kind: 'failed', reason: PROMOTE_FAILURE_COPY.unreadable }
      : failure
  }
}

/**
 * Every image the workspace still needs — its live documents, its trash and
 * its saved versions, by `scanFileReferences`, the definition both keepers'
 * file collections judge by — each mapped to a document path for the
 * daemon's file route. Files there are kept per workspace and the path in the
 * address is only checked for its grammar, so an image no live document
 * names goes under the path of whatever named it first.
 */
function imageAddresses(
  record: LoroDoc,
  entries: ReturnType<typeof readWorkspaceDocuments>,
  scan: CarriedPlanes['scan'],
): Map<string, string> {
  const refs = new Map<string, string>()
  for (const entry of entries) {
    for (const fileId of collectImageRefIds(documentContainers(record, entry.documentId))) {
      if (!refs.has(fileId)) refs.set(fileId, entry.path)
    }
  }
  const fallback = entries[0]?.path ?? readTrashEntries(record)[0]?.path
  for (const fileId of scan.referenced) {
    if (!refs.has(fileId) && fallback !== undefined) refs.set(fileId, fallback)
  }
  return refs
}

type PromotedBlobs = Extract<PromoteWorkspaceResult, { kind: 'ok' }>['blobs']

/**
 * One image's bytes, `null` when the store has none, `undefined` when this
 * device could not read them. The record has already merged by the time
 * images are read, so an unreadable image fails that image alone, the way a
 * refused upload does — and is not `missing`, which claims the bytes are gone.
 */
async function readImage(
  fileStore: DocumentFileStore,
  workspaceId: string,
  fileId: string,
): Promise<Blob | null | undefined> {
  // The store is keyed by the reference the document carries — what the
  // editor's upload writes — while the scan and the daemon's file route
  // speak the bare id. Read under the bare id, every real picture is
  // `missing`, and a missing picture holds the browser copy back from
  // demotion for good.
  const stored = await fileStore.read(newImageRef(fileId))
  if (stored.kind === 'blob') return stored.blob
  if (stored.kind === 'absent') return null
  log.warn('image could not be read for the move', {
    workspaceId,
    fileId,
    name: errorName(stored.error),
  })
  return undefined
}

/** Sends each referenced image through the daemon's file route, one outcome per file. */
async function transferImages(
  fetch: typeof globalThis.fetch,
  keeperBaseUrl: string,
  workspaceId: string,
  fileStore: DocumentFileStore,
  refs: ReadonlyArray<readonly [fileId: string, path: string]>,
): Promise<PromotedBlobs> {
  const blobs: PromotedBlobs = { transferred: [], missing: [], failed: [] }
  // One image at a time, on purpose: each is read whole into memory before
  // its PUT, so a workspace of large pictures uploaded at once would hold
  // them all, and would race every upload against the daemon's file route.
  for (const [fileId, path] of refs) {
    const blob = await readImage(fileStore, workspaceId, fileId)
    if (blob === undefined) {
      blobs.failed.push({ fileId, reason: 'This browser could not read that image.' })
      continue
    }
    if (blob === null) {
      blobs.missing.push(fileId)
      continue
    }
    const contentType = blob.type || 'image/png'
    // A type or size the daemon is certain to refuse is not attempted: the
    // upload would only come back 415 or 413, and would cost the bytes first.
    const refusal = imageRefusal({ type: contentType, size: blob.size })
    if (refusal !== null) {
      blobs.failed.push({ fileId, reason: refusal })
      continue
    }
    const url = `${keeperBaseUrl}${documentFileApiUrl(workspaceId, path, fileId)}`
    const put = await putDaemonImage(fetch, url, blob, contentType)
    if (put.ok) blobs.transferred.push(fileId)
    else blobs.failed.push({ fileId, reason: put.reason })
  }
  return blobs
}

async function promoteWorkspaceUnsafe(
  options: PromoteWorkspaceOptions,
): Promise<PromoteWorkspaceResult> {
  const { fetch, keeperBaseUrl, workspaceId, workspaceDocs, onProgress } = options
  // The keeper's own store, like BrowserWorkspaceDocs above: both address
  // the same claimed database, so tests seed through the production path.
  const fileStore = new DocumentFileStore()

  const sourceWorkspaceId = getBrowserWorkspaceId()
  const record = await workspaceDocs.open(sourceWorkspaceId)
  if (record === null) {
    return { kind: 'failed', reason: 'This browser keeps no workspace record to promote.' }
  }
  // Read from the record ITSELF, not echoed back from the daemon: identity
  // preservation means these exact ids resolve on the other side, and the
  // acceptance tests hold the route to that.
  const entries = readWorkspaceDocuments(record)
  const promotedDocumentIds = entries.map((entry) => entry.documentId)
  // Its own failure, not the network one the outer catch reports: nothing
  // has left the browser yet, and a retry would not be cured by a connection.
  const planes = await readCarriedPlanes(record, sourceWorkspaceId).catch((err: unknown) => {
    log.warn('carried planes could not be read', { sourceWorkspaceId, name: errorName(err) })
    return null
  })
  if (planes === null) {
    return { kind: 'failed', reason: 'This browser could not read its workspace to move it.' }
  }
  const snapshot = bytesToBase64Url(new Uint8Array(record.export({ mode: 'snapshot' })))
  const fitted = fitCarriedPlanes(snapshot, planes)

  onProgress?.('record')
  const { promoted, sent } = await promoteWithinBudget(record, fitted, {
    fetch,
    keeperBaseUrl,
    workspaceId,
    snapshot,
    wording: DAEMON_WORDING,
  })
  if (!promoted.ok) return { kind: 'failed', reason: promoted.reason }

  // The record is on the daemon now, so its documents already resolve there;
  // the images travel last, and per-file — a single unreadable or refused
  // upload lands in the report instead of failing the merge that already
  // happened.
  onProgress?.('blobs')
  const blobs = await transferImages(fetch, keeperBaseUrl, workspaceId, fileStore, [
    ...imageAddresses(record, entries, planes.scan),
  ])

  return {
    kind: 'ok',
    sourceWorkspaceId,
    promotedDocumentIds,
    shadowedPaths: promoted.shadowedPaths,
    blobs,
    leftBehind: [...planes.leftBehind, ...sent.leftBehind, ...promoted.leftBehind],
    versionsLeftBehind: sent.versionsLeftBehind,
  }
}

/**
 * The promote route rather than the sync surface's update: the same merge,
 * plus the planes beside it and the checkpoints a person's move leaves.
 *
 * A keeper that refuses the versions as costing more to check than one move
 * allows states its budget, and the move is re-sent ONCE with the newest
 * versions that fit under it — the rest stay behind, named, so the browser
 * copy that alone holds them is kept. Once, because a keeper refusing what
 * was fitted to its own number is not a refusal another fitting would cure.
 */
async function promoteWithinBudget(
  record: LoroDoc,
  fitted: FittedPlanes,
  request: Omit<PromoteRequestOptions, 'planes'>,
): Promise<{ promoted: PromoteRequestResult; sent: FittedPlanes }> {
  const promoted = await requestPromote({ ...request, planes: fitted })
  if (promoted.ok || promoted.judgedLimit === undefined || fitted.versions.length === 0) {
    return { promoted, sent: fitted }
  }
  const { kept, dropped } = versionsWithinJudgedBudget(
    record,
    fitted.versions,
    promoted.judgedLimit,
  )
  const sent: FittedPlanes = {
    ...fitted,
    versions: kept,
    leftBehind:
      dropped === 0
        ? fitted.leftBehind
        : [
            ...fitted.leftBehind,
            `${countOf(dropped, 'older saved version', 'older saved versions')}: checking more would take the daemon longer than one move allows`,
          ],
    versionsLeftBehind: fitted.versionsLeftBehind + dropped,
  }
  return { promoted: await requestPromote({ ...request, planes: sent }), sent }
}
