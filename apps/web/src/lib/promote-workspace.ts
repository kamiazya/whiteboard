/**
 * Promotion: the browser keeper's whole workspace record transferred into a
 * daemon workspace, identity and history intact.
 *
 * A plain function, not a component — the UI that offers it arrives in its
 * own increment, and keeping loro-crdt behind the lazy chunks is that
 * increment's job too (entry-graph-loro-free.test.ts guards the entry
 * closure; nothing on the entry path may import this file statically).
 *
 * The core move needs no dedicated route: POSTing the record's snapshot to
 * the existing workspace-document/update endpoint IS the CRDT merge — the
 * daemon side of exactly these bytes is pinned by mcp-server's
 * promote-workspace.test.ts (identity, shadowed collisions, idempotent
 * retry, the unregistered-target 404, and the fan-out to live sessions).
 *
 * The caller owns the fold: a legacy row-plane document that has not been
 * absorbed into the tree yet is not in the record this reads, so the promote
 * surface must run after the startup fold (any FoldingBrowserIndex read
 * performs it; the Settings section folds explicitly before counting, since
 * it can be a session's first surface) — the same ordering every other
 * record consumer relies on.
 */

import {
  apiErrorReason,
  documentFileApiUrl,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import {
  collectImageRefIds,
  documentContainers,
  readWorkspaceDocuments,
} from '@kamiazya/whiteboard-loro-adapter'
import type { WorkspaceDocs } from '@kamiazya/whiteboard-workspace-index'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { listDocuments } from './daemon-api-client.js'
import { DocumentFileStore } from './document-file-store.js'

export interface PromoteWorkspaceOptions {
  fetch: typeof globalThis.fetch
  daemonBaseUrl: string
  /** The TARGET daemon workspace — promotion merges into an existing one. */
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
       * uploads the daemon refused or the network dropped — safe to re-run,
       * the whole promotion is an idempotent merge.
       */
      blobs: { transferred: string[]; missing: string[]; failed: string[] }
    }
  | { kind: 'failed'; reason: string }

async function failureReason(res: Response): Promise<string> {
  try {
    const reason = apiErrorReason(await res.json())
    if (reason !== undefined) return reason
  } catch {
    // fall through to the generic message below
  }
  return `Request failed (${res.status}).`
}

export async function promoteWorkspace(
  options: PromoteWorkspaceOptions,
): Promise<PromoteWorkspaceResult> {
  try {
    return await promoteWorkspaceUnsafe(options)
  } catch {
    // A thrown fetch (daemon offline, connection dropped mid-transfer) must
    // surface as a structured failure the confirmation UI can show, never a
    // rejected promise. The transfer itself is safe to re-run: the same
    // snapshot re-POSTed is an idempotent merge.
    return { kind: 'failed', reason: 'Could not reach the daemon (network error).' }
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

async function promoteWorkspaceUnsafe(
  options: PromoteWorkspaceOptions,
): Promise<PromoteWorkspaceResult> {
  const { fetch, daemonBaseUrl, workspaceId, workspaceDocs, onProgress } = options
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

  onProgress?.('record')
  const res = await fetch(
    `${daemonBaseUrl}/api/w/${encodeURIComponent(workspaceId)}/workspace-document/update`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: record.export({ mode: 'snapshot' }) as BodyInit,
    },
  )
  if (!res.ok) {
    return { kind: 'failed', reason: await failureReason(res) }
  }

  // The daemon's own post-merge list is what reports collisions — shadowed
  // is its projection, not something this side can compute without knowing
  // what the target already held. A failed read-back degrades to "no
  // collisions reported", never to a failed promotion: the merge landed.
  const shadowedPaths = await listDocuments(fetch, daemonBaseUrl, workspaceId)
    .then((response) =>
      response.documents.filter((entry) => entry.shadowed === true).map((entry) => entry.path),
    )
    .catch(() => [])

  // The record is on the daemon now, so its documents already resolve there;
  // the images travel last, and per-file — a single unreadable or refused
  // upload lands in the report instead of failing the merge that already
  // happened.
  onProgress?.('blobs')
  const blobs = { transferred: [] as string[], missing: [] as string[], failed: [] as string[] }
  for (const [fileId, path] of collectImageRefs(record, entries)) {
    const blob = await fileStore.get(fileId)
    if (blob === null) {
      blobs.missing.push(fileId)
      continue
    }
    const res = await fetch(`${daemonBaseUrl}${documentFileApiUrl(workspaceId, path, fileId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': blob.type || 'image/png' },
      body: blob,
    }).catch(() => null)
    if (res?.ok) blobs.transferred.push(fileId)
    else blobs.failed.push(fileId)
  }

  return { kind: 'ok', sourceWorkspaceId, promotedDocumentIds, shadowedPaths, blobs }
}
