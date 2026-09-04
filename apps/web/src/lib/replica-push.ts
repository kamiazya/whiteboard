/**
 * The return half of ADR-0023 decision 3's offline edits: ops the replica
 * took while its keeper was unreachable, shipped back as an ordinary CRDT
 * update through the same idempotent merge endpoint the whole-workspace
 * promote posts to. The daemon imports; nothing is replaced.
 *
 * `syncedFrontier` is the registry's claim of what the daemon already
 * holds (recorded by the pull, from the pulled bytes alone). With it, the
 * payload is exactly the ops past that point — and a replica with nothing
 * past it ships NOTHING, so the caller may invoke this on every daemon
 * resolve without pricing a request. Without it (an entry from before
 * offline edits existed), one full snapshot goes across; the merge makes
 * that safe, and the result's frontier ends the snapshot era for good.
 *
 * A plain function behind the lazy chunks, like replica-cache.ts: it
 * imports loro-crdt, so nothing on the entry path may import this file
 * statically (entry-graph-loro-free.test.ts guards the closure).
 */
import type { WorkspaceDocs } from '@kamiazya/whiteboard-workspace-index'
import { VersionVector } from 'loro-crdt'
import { decodeVersionFromRegistry, encodeVersionForRegistry } from './replica-cache.js'

export interface PushReplicaEditsOptions {
  fetch: typeof globalThis.fetch
  daemonBaseUrl: string
  /** The daemon workspace the replica mirrors — the KEEPER's id. */
  workspaceId: string
  /** The browser's own planes (production: `new BrowserWorkspaceDocs()`). */
  workspaceDocs: WorkspaceDocs
  /** Base64 VersionVector of what the daemon is known to hold. */
  syncedFrontier?: string
}

export type PushReplicaEditsResult =
  | { kind: 'clean' }
  | { kind: 'ok'; syncedAt: string; syncedFrontier: string }
  | { kind: 'failed'; reason: string }

export async function pushReplicaEdits(
  options: PushReplicaEditsOptions,
): Promise<PushReplicaEditsResult> {
  const { fetch, daemonBaseUrl, workspaceId, workspaceDocs, syncedFrontier } = options
  try {
    const doc = await workspaceDocs.open(workspaceId)
    if (doc === null) return { kind: 'clean' }
    const current = doc.oplogVersion()

    let payload: Uint8Array
    if (syncedFrontier === undefined) {
      payload = doc.export({ mode: 'snapshot' })
    } else {
      const synced = VersionVector.decode(decodeVersionFromRegistry(syncedFrontier))
      const cmp = current.compare(synced)
      // current ⊆ synced: the daemon already holds everything local.
      if (cmp === 0 || cmp === -1) return { kind: 'clean' }
      payload = doc.export({ mode: 'update', from: synced })
    }

    const res = await fetch(
      `${daemonBaseUrl}/api/w/${encodeURIComponent(workspaceId)}/workspace-document/update`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: payload as BodyInit,
      },
    )
    if (!res.ok) return { kind: 'failed', reason: `Update request failed (${res.status}).` }
    return {
      kind: 'ok',
      syncedAt: new Date().toISOString(),
      syncedFrontier: encodeVersionForRegistry(current.encode()),
    }
  } catch {
    return { kind: 'failed', reason: 'Could not reach the daemon (network error).' }
  }
}
