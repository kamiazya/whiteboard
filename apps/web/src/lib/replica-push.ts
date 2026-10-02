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
import { workspaceDocumentApiUrl } from '@kamiazya/whiteboard-daemon-client/api-contracts/document-url'
import { base64ToBytes, bytesToBase64 } from '@kamiazya/whiteboard-model'
import type { WorkspaceDocs } from '@kamiazya/whiteboard-workspace-index'
import { VersionVector } from 'loro-crdt'
import { ReplicaKeyWithheldError } from './sealed-document-store.js'

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
  /** See `CacheDaemonWorkspaceResult`'s `'withheld'` — the same reconnect-not-retry distinction. */
  | { kind: 'withheld' }
  | { kind: 'failed'; reason: string }

export async function pushReplicaEdits(
  options: PushReplicaEditsOptions,
): Promise<PushReplicaEditsResult> {
  const { fetch, daemonBaseUrl, workspaceId, workspaceDocs, syncedFrontier } = options
  try {
    const doc = await workspaceDocs.open(workspaceId)
    if (doc === null) return { kind: 'clean' }
    const current = doc.oplogVersion()

    // A marker that does not decode is as good as none: the whole record is
    // sent, which the daemon's CRDT import absorbs idempotently.
    const syncedBytes = syncedFrontier === undefined ? null : base64ToBytes(syncedFrontier)
    let payload: Uint8Array
    if (syncedBytes === null) {
      payload = doc.export({ mode: 'snapshot' })
    } else {
      const synced = VersionVector.decode(syncedBytes)
      const cmp = current.compare(synced)
      // current ⊆ synced: the daemon already holds everything local.
      if (cmp === 0 || cmp === -1) return { kind: 'clean' }
      payload = doc.export({ mode: 'update', from: synced })
    }

    const res = await fetch(`${daemonBaseUrl}${workspaceDocumentApiUrl(workspaceId, 'update')}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: payload as BodyInit,
    })
    if (!res.ok) return { kind: 'failed', reason: `Update request failed (${res.status}).` }
    return {
      kind: 'ok',
      syncedAt: new Date().toISOString(),
      syncedFrontier: bytesToBase64(current.encode()),
    }
  } catch (err) {
    if (err instanceof ReplicaKeyWithheldError) return { kind: 'withheld' }
    return { kind: 'failed', reason: 'Could not reach the daemon (network error).' }
  }
}
