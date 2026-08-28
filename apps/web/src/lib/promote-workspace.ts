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
 * performs it) — the same ordering every other record consumer relies on.
 */
import { readWorkspaceDocuments } from '@kamiazya/whiteboard-loro-adapter'
import { apiErrorReason } from '@kamiazya/whiteboard-mcp/api-contracts'
import type { WorkspaceDocs } from '@kamiazya/whiteboard-workspace-index'
import { listDocuments } from './daemon-api-client.js'
import { BROWSER_WORKSPACE_ID } from './local-document-summary.js'

export interface PromoteWorkspaceOptions {
  fetch: typeof globalThis.fetch
  daemonBaseUrl: string
  /** The TARGET daemon workspace — promotion merges into an existing one. */
  workspaceId: string
  /** The browser keeper's records (production: `new BrowserWorkspaceDocs()`). */
  workspaceDocs: WorkspaceDocs
}

export type PromoteWorkspaceResult =
  | {
      kind: 'ok'
      /** Every documentId the record carried across — the same ids, by design. */
      promotedDocumentIds: string[]
      /** Paths the merge left contested; surfaced, never auto-resolved. */
      shadowedPaths: string[]
      /** File/image bytes live outside the record; their transfer is its own increment. */
      blobsPending: true
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

async function promoteWorkspaceUnsafe(
  options: PromoteWorkspaceOptions,
): Promise<PromoteWorkspaceResult> {
  const { fetch, daemonBaseUrl, workspaceId, workspaceDocs } = options

  const record = await workspaceDocs.open(BROWSER_WORKSPACE_ID)
  if (record === null) {
    return { kind: 'failed', reason: 'This browser keeps no workspace record to promote.' }
  }
  // Read from the record ITSELF, not echoed back from the daemon: identity
  // preservation means these exact ids resolve on the other side, and the
  // acceptance tests hold the route to that.
  const promotedDocumentIds = readWorkspaceDocuments(record).map((entry) => entry.documentId)

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

  return { kind: 'ok', promotedDocumentIds, shadowedPaths, blobsPending: true }
}
