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
 * (mcp-server's promote-workspace.test.ts pins identity, shadowed
 * collisions, idempotent retry and the unregistered-target 404), and writes
 * one explicit human checkpoint per promoted document.
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
import { refusalReasonOf } from '@kamiazya/whiteboard-daemon-client/api-contracts/refusal-reason'
import {
  collectImageRefIds,
  documentContainers,
  readWorkspaceDocuments,
} from '@kamiazya/whiteboard-loro-adapter'
import { bytesToBase64Url } from '@kamiazya/whiteboard-model'
import type { WorkspaceDocs } from '@kamiazya/whiteboard-workspace-index'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { listDocuments } from './daemon-api-client.js'
import { daemonContractError, logDaemonContractError } from './daemon-contract-error.js'
import { DocumentFileStore } from './document-file-store.js'
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
 * The image references the record's spatial documents carry, each mapped to
 * its owning document's path (the address the daemon's file route wants).
 * The walk itself is collectImageRefIds — shared with the daemon-side GC's
 * live-state pass, so the two sides cannot drift on what counts as a live
 * reference. Markdown documents embed images only through spatial nodes.
 */
function collectImageRefs(
  record: Parameters<typeof readWorkspaceDocuments>[0],
  entries: ReturnType<typeof readWorkspaceDocuments>,
): Map<string, string> {
  const refs = new Map<string, string>()
  for (const entry of entries) {
    if (entry.kind !== 'spatial') continue
    for (const fileId of collectImageRefIds(documentContainers(record, entry.documentId))) {
      if (!refs.has(fileId)) refs.set(fileId, entry.path)
    }
  }
  return refs
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
    const blob = await fileStore.get(fileId)
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

  const snapshot = new Uint8Array(record.export({ mode: 'snapshot' }))

  onProgress?.('record')
  // The promote route rather than the sync surface's update: the same merge,
  // plus the explicit checkpoints a person's move leaves behind.
  const promoteUrl = `${keeperBaseUrl}${workspaceDocumentApiUrl(workspaceId, 'promote')}`
  const res = await fetch(promoteUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ snapshot: bytesToBase64Url(snapshot) }),
  })
  if (!res.ok) {
    return { kind: 'failed', reason: await failureReason(res) }
  }
  const promoted = promoteWorkspaceResponseSchema.safeParse(await res.json().catch(() => null))
  if (!promoted.success) {
    logDaemonContractError(daemonContractError(promoteUrl, promoted.error))
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
    ...collectImageRefs(record, entries),
  ])

  return {
    kind: 'ok',
    sourceWorkspaceId,
    promotedDocumentIds,
    shadowedPaths,
    blobs,
  }
}
