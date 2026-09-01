/**
 * The demote half of ADR-0023's decision 2: pull a daemon workspace's whole
 * record through the existing workspace-document/snapshot route and store it
 * in this browser's own planes as a REPLICA — readable, overwritten by sync,
 * never authoritative. `docRefKey` accepts a daemon workspaceId unchanged,
 * so the replica lives in the same IndexedDB planes browser-kept workspaces
 * do, keyed by the daemon workspace's own id.
 *
 * A plain function behind the lazy chunks, like promote-workspace.ts: it
 * imports loro-crdt, so nothing on the entry path may import this file
 * statically (entry-graph-loro-free.test.ts guards the closure).
 *
 * A re-pull is a MERGE, not a replacement: the pulled snapshot is imported
 * into the stored replica's doc and saved, which appends only what the store
 * lacks (ADR-0020's data plane — ops carry their own identity). Replacing
 * wholesale would discard nothing today, but the merge shape is what stays
 * correct once a replica can also carry offline edits.
 */

import { readWorkspaceDocuments } from '@kamiazya/whiteboard-loro-adapter'
import type { WorkspaceDocs } from '@kamiazya/whiteboard-workspace-index'
import { LoroDoc } from 'loro-crdt'

export interface CacheDaemonWorkspaceOptions {
  fetch: typeof globalThis.fetch
  daemonBaseUrl: string
  /** The daemon workspace to cache — the KEEPER's id, not a browser one. */
  workspaceId: string
  /** The browser's own planes (production: `new BrowserWorkspaceDocs()`). */
  workspaceDocs: WorkspaceDocs
}

export type CacheDaemonWorkspaceResult =
  | { kind: 'ok'; syncedAt: string; documentCount: number }
  | { kind: 'failed'; reason: string }

export async function cacheDaemonWorkspace(
  options: CacheDaemonWorkspaceOptions,
): Promise<CacheDaemonWorkspaceResult> {
  const { fetch, daemonBaseUrl, workspaceId, workspaceDocs } = options
  try {
    const res = await fetch(
      `${daemonBaseUrl}/api/w/${encodeURIComponent(workspaceId)}/workspace-document/snapshot`,
    )
    if (!res.ok) {
      return { kind: 'failed', reason: `Snapshot request failed (${res.status}).` }
    }
    const bytes = new Uint8Array(await res.arrayBuffer())
    const doc = (await workspaceDocs.open(workspaceId)) ?? new LoroDoc()
    doc.import(bytes)
    await workspaceDocs.save(workspaceId, doc)
    return {
      kind: 'ok',
      syncedAt: new Date().toISOString(),
      documentCount: readWorkspaceDocuments(doc).length,
    }
  } catch {
    // A thrown fetch (daemon offline mid-pull) surfaces as a structured
    // failure the caller can report; the pull is safe to re-run.
    return { kind: 'failed', reason: 'Could not reach the daemon (network error).' }
  }
}
