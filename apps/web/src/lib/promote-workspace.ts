/**
 * Promotion: the browser keeper's whole workspace record transferred to
 * ANOTHER KEEPER's workspace, identity and history intact.
 *
 * The destination is `keeperBaseUrl` and has always been a plain parameter.
 * It is not called `daemonBaseUrl`: a daemon is only one kind of keeper, and
 * a name saying so would make the transfer read as daemon-shaped when nothing
 * about it is. ADR-0023 makes the destination the workspace's new KEEPER, so
 * that is the word. A browser
 * transfers directly to a SaaS or a self-hosted server with no daemon hop
 * (user decision, 2026-09-22); the receiving route is not gated on
 * `authMode`, so server mode already answers it.
 *
 * A plain function, not a component — the UI that offers it arrives in its
 * own increment, and keeping loro-crdt behind the lazy chunks is that
 * increment's job too (entry-graph-loro-free.test.ts guards the entry
 * closure; nothing on the entry path may import this file statically).
 *
 * The core move is a CRDT merge of the record's snapshot: the daemon's
 * promote route imports exactly these bytes the way its sync surface would
 * (mcp-server's workspace-promote.test.ts pins identity, shadowed
 * collisions, idempotent retry and the unregistered-target 404), and writes
 * one explicit human checkpoint per promoted document. Beside the record
 * travel the planes it only points at — each trash entry's evacuated bytes
 * and the saved version rows — and every image any of them names.
 *
 * No passkey assertion travels with it. The only destination is the daemon
 * on this machine, which has one person — the owner who alone can reach its
 * socket (ADR-0050 decision 3) — so there is nobody for an assertion to tell
 * apart. A transfer to a keeper the person does NOT own goes through
 * `accept-transferred-record.ts`, at that keeper's own origin.
 *
 * The caller owns the fold: a legacy row-plane document that has not been
 * absorbed into the tree yet is not in the record this reads, so the promote
 * surface must run after the startup fold (any FoldingBrowserIndex read
 * performs it; the Settings section folds explicitly before counting, since
 * it can be a session's first surface) — the same ordering every other
 * record consumer relies on.
 */

import {
  documentFileApiUrl,
  promoteWorkspaceResponseSchema,
  workspaceDocumentApiUrl,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import {
  PROMOTE_REQUEST_LIMIT_BYTES,
  type PromotedTrashBytes,
  type PromotedVersion,
  type PromoteWorkspaceRequest,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/promotion'
import { refusalReasonOf } from '@kamiazya/whiteboard-daemon-client/api-contracts/refusal-reason'
import {
  collectImageRefIds,
  documentContainers,
  readTrashEntries,
  readWorkspaceDocuments,
  scanFileReferences,
} from '@kamiazya/whiteboard-loro-adapter'
import { bytesToBase64Url, newImageRef } from '@kamiazya/whiteboard-model'
import type { WorkspaceDocs } from '@kamiazya/whiteboard-workspace-index'
import type { LoroDoc } from 'loro-crdt'
import { savedVersionReads, savedVersionRows, type VersionRow } from './browser-version-store.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { listDocuments } from './daemon-api-client.js'
import { daemonContractError } from './daemon-contract-error.js'
import { DocumentFileStore } from './document-file-store.js'
import { IdbBlobStore } from './idb-blob-store.js'
import { imageRefusal, uploadRefusalReason } from './image-upload-policy.js'

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
       * `missing` are references whose bytes are already gone in the browser
       * (the promoted document was equally broken before), `failed` are
       * uploads the daemon refused or the network dropped, each with the
       * reason — a type or size the daemon will never store stays failed on
       * every re-run, while a dropped connection is cured by one (the whole
       * promotion is an idempotent merge).
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
    }
  | { kind: 'failed'; reason: string }

async function failureReason(res: Response): Promise<string> {
  return (await refusalReasonOf(res, `Request failed (${res.status}).`)).reason
}

export async function promoteWorkspace(
  options: PromoteWorkspaceOptions,
): Promise<PromoteWorkspaceResult> {
  try {
    return await promoteWorkspaceUnsafe(options)
  } catch {
    // A thrown fetch (the keeper unreachable, connection dropped
    // mid-transfer) must surface as a structured failure the confirmation UI
    // can show, never a rejected promise. The transfer itself is safe to
    // re-run: the same snapshot re-POSTed is an idempotent merge.
    return { kind: 'failed', reason: 'Could not reach the destination (network error).' }
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
  scan: FileReferenceScan,
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

type FileReferenceScan = Awaited<ReturnType<typeof scanFileReferences>>

/** What travels beside the record, and what is left behind with a reason. */
interface CarriedPlanes {
  readonly trash: PromotedTrashBytes[]
  readonly versions: PromotedVersion[]
  readonly leftBehind: string[]
  readonly scan: FileReferenceScan
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/** The wire form of a version row: no device, which only a keeper can back with a key. */
function promotedVersion(row: VersionRow): PromotedVersion {
  let operator: PromotedVersion['operator']
  if (row.operator !== undefined) {
    const { actor: _device, ...stated } = row.operator
    operator = stated
  }
  return {
    id: row.id,
    documentId: row.documentId,
    createdAt: Math.trunc(row.createdAt),
    auto: row.auto === true,
    ...(row.label === undefined ? {} : { label: row.label }),
    ...(operator === undefined ? {} : { operator }),
    ...(row.restoredFrom === undefined ? {} : { restoredFrom: row.restoredFrom }),
    frontiers: bytesToBase64Url(row.frontiers),
  }
}

/**
 * Reads the planes the record only points at — each trash entry's bytes and
 * the saved versions — through the same scan that finds the images, so what
 * is carried is exactly what was judged. Fails closed: a version or a trash
 * entry the scan could not read is left behind and named, never sent.
 */
async function readCarriedPlanes(
  record: LoroDoc,
  sourceWorkspaceId: string,
): Promise<CarriedPlanes> {
  const blobStore = new IdbBlobStore()
  const trashBytes = new Map<string, Uint8Array>()
  const rows = await savedVersionRows(sourceWorkspaceId)
  const scan = await scanFileReferences(record, {
    trashBytes: async (entry) => {
      const bytes = (await blobStore.get({ ref: entry.blob }))?.bytes ?? null
      if (bytes !== null) trashBytes.set(entry.documentId, bytes)
      return bytes
    },
    versions: savedVersionReads(record, rows),
  })
  const leftBehind: string[] = []
  const unjudgedTrash = new Set(
    scan.unjudged.flatMap((held) => (held.kind === 'trash' ? [held.documentId] : [])),
  )
  const trash: PromotedTrashBytes[] = []
  for (const entry of readTrashEntries(record)) {
    const bytes = trashBytes.get(entry.documentId)
    if (bytes === undefined || unjudgedTrash.has(entry.documentId)) {
      leftBehind.push(`the trashed document "${entry.path}" cannot be read in this browser`)
    } else trash.push({ documentId: entry.documentId, bytes: bytesToBase64Url(bytes) })
  }
  const unjudgedVersions = new Set(
    scan.unjudged.flatMap((held) => (held.kind === 'version' ? [held.versionId] : [])),
  )
  if (unjudgedVersions.size > 0) {
    leftBehind.push(
      `${plural(unjudgedVersions.size, 'saved version', 'saved versions')} could not be read`,
    )
  }
  if (scan.unjudged.some((held) => held.kind === 'unreadable-node')) {
    leftBehind.push('part of the workspace could not be read by this version of the app')
  }
  const holders = new Set([
    ...readWorkspaceDocuments(record).map((entry) => entry.documentId),
    ...trash.map((carried) => carried.documentId),
  ])
  const versions = rows
    .filter((row) => holders.has(row.documentId) && !unjudgedVersions.has(row.id))
    .map(promotedVersion)
  return { trash, versions, leftBehind, scan }
}

/**
 * The request body, inside the ceiling the keeper refuses past. The record
 * and the version rows are small beside a document's evacuated bytes, so
 * trash entries are what gives way: each that does not fit is left behind and
 * named, and the move goes ahead with the rest.
 */
function fittedBody(
  snapshot: string,
  planes: CarriedPlanes,
): { body: PromoteWorkspaceRequest; leftBehind: string[] } {
  const encoder = new TextEncoder()
  const base: PromoteWorkspaceRequest = { snapshot, trash: [], versions: planes.versions }
  let size = encoder.encode(JSON.stringify(base)).byteLength
  const trash: PromotedTrashBytes[] = []
  let tooLarge = 0
  for (const carried of planes.trash) {
    // The item plus the comma that joins it to the one before.
    const itemSize = encoder.encode(JSON.stringify(carried)).byteLength + 1
    if (size + itemSize > PROMOTE_REQUEST_LIMIT_BYTES) tooLarge += 1
    else {
      trash.push(carried)
      size += itemSize
    }
  }
  const leftBehind =
    tooLarge === 0
      ? []
      : [
          `${plural(tooLarge, 'trashed document is', 'trashed documents are')} too large to move with the rest`,
        ]
  return { body: { ...base, trash }, leftBehind }
}

/** What the keeper's own read-back says it did not take of what was sent. */
function unconfirmed(
  body: PromoteWorkspaceRequest,
  answer: { trashStored: readonly string[]; versionsKept: readonly string[] },
): string[] {
  const stored = new Set(answer.trashStored)
  const kept = new Set(answer.versionsKept)
  const trash = (body.trash ?? []).filter((carried) => !stored.has(carried.documentId)).length
  const versions = (body.versions ?? []).filter((version) => !kept.has(version.id)).length
  return [
    ...(trash === 0
      ? []
      : [`${plural(trash, 'trashed document', 'trashed documents')} did not reach the daemon`]),
    ...(versions === 0
      ? []
      : [`${plural(versions, 'saved version', 'saved versions')} did not reach the daemon`]),
  ]
}

type PromotedBlobs = Extract<PromoteWorkspaceResult, { kind: 'ok' }>['blobs']

/** Sends each referenced image through the daemon's file route, one outcome per file. */
async function transferImages(
  fetch: typeof globalThis.fetch,
  keeperBaseUrl: string,
  workspaceId: string,
  fileStore: DocumentFileStore,
  refs: ReadonlyArray<readonly [fileId: string, path: string]>,
): Promise<PromotedBlobs> {
  const blobs: PromotedBlobs = { transferred: [], missing: [], failed: [] }
  for (const [fileId, path] of refs) {
    // The store is keyed by the reference the document carries — what the
    // editor's upload writes — while the scan and the daemon's file route
    // speak the bare id. Read under the bare id, every real picture is
    // `missing`, and a missing picture holds the browser copy back from
    // demotion for good.
    const blob = await fileStore.get(newImageRef(fileId))
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
    const res = await fetch(`${keeperBaseUrl}${documentFileApiUrl(workspaceId, path, fileId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: blob,
    }).catch(() => null)
    if (res === null) {
      blobs.failed.push({ fileId, reason: 'Could not reach the daemon to store that image.' })
    } else if (res.ok) blobs.transferred.push(fileId)
    else blobs.failed.push({ fileId, reason: uploadRefusalReason(res.status) })
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
  const planes = await readCarriedPlanes(record, sourceWorkspaceId).catch(() => null)
  if (planes === null) {
    return { kind: 'failed', reason: 'This browser could not read its workspace to move it.' }
  }
  const fitted = fittedBody(
    bytesToBase64Url(new Uint8Array(record.export({ mode: 'snapshot' }))),
    planes,
  )

  onProgress?.('record')
  // The promote route rather than the sync surface's update: the same merge,
  // plus the planes beside it and the checkpoints a person's move leaves.
  const promoteUrl = `${keeperBaseUrl}${workspaceDocumentApiUrl(workspaceId, 'promote')}`
  const res = await fetch(promoteUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fitted.body),
  })
  if (!res.ok) {
    return { kind: 'failed', reason: await failureReason(res) }
  }
  const promoted = promoteWorkspaceResponseSchema.safeParse(await res.json().catch(() => null))
  if (!promoted.success) {
    daemonContractError(promoteUrl, promoted.error)
    return { kind: 'failed', reason: 'The daemon answered the move with an unexpected response.' }
  }

  // The daemon's own post-merge list is what reports collisions — shadowed
  // is its projection, not something this side can compute without knowing
  // what the target already held. A failed read-back degrades to "no
  // collisions reported", never to a failed promotion: the merge landed.
  const shadowedPaths = await listDocuments(fetch, keeperBaseUrl, workspaceId)
    .then((response) =>
      response.documents.filter((entry) => entry.shadowed === true).map((entry) => entry.path),
    )
    .catch(() => [])

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
    shadowedPaths,
    blobs,
    leftBehind: [
      ...planes.leftBehind,
      ...fitted.leftBehind,
      ...unconfirmed(fitted.body, promoted.data),
    ],
  }
}
