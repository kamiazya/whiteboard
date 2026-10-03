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

import { workspaceDocumentApiUrl } from '@kamiazya/whiteboard-daemon-client/api-contracts/document-url'
import { readWorkspaceDocuments } from '@kamiazya/whiteboard-loro-adapter'
import { bytesToBase64 } from '@kamiazya/whiteboard-model'
import type { WorkspaceDocs } from '@kamiazya/whiteboard-workspace-index'
import { LoroDoc } from 'loro-crdt'
import { getAppLogger } from './app-logger.js'
import { markReplica, openDocumentStore, replicaKeyStatus } from './replica-store.js'
import { stopReplicaReadableOffline } from './replica-unlock.js'
import { forgetReplicaEntry } from './replicas.js'
import { ReplicaKeyRotatedError, ReplicaKeyWithheldError } from './sealed-document-store.js'
import { createUserSettingsStore } from './user-settings-store.js'

const log = getAppLogger('replica-cache')

export interface CacheDaemonWorkspaceOptions {
  fetch: typeof globalThis.fetch
  daemonBaseUrl: string
  /** The daemon workspace to cache — the KEEPER's id, not a browser one. */
  workspaceId: string
  /** The browser's own planes (production: `new BrowserWorkspaceDocs()`). */
  workspaceDocs: WorkspaceDocs
}

export type CacheDaemonWorkspaceResult =
  | {
      kind: 'ok'
      syncedAt: string
      documentCount: number
      /**
       * What the DAEMON is known to hold, from the pulled bytes ALONE —
       * never from the merged record, which may already carry offline
       * edits the daemon has not seen. The push exports from this point;
       * deriving it from the merge would mark local edits as sent.
       */
      syncedFrontier: string
      /**
       * The key generation the stored bytes were just sealed under, when the
       * daemon named one. The caller records it with the registry entry —
       * the next read compares it with the key then held.
       */
      keyId?: string
    }
  /**
   * The pull reached the daemon, but this build's session key for the
   * workspace is withheld (`ReplicaKeyWithheldError`) — a reconnect
   * question, never a network one. Kept distinct from `'failed'` so a
   * caller can tell a member to reconnect instead of retrying the request.
   */
  | { kind: 'withheld' }
  | { kind: 'failed'; reason: string }

/**
 * The stored copy to merge the pull into — or a fresh one when the stored
 * copy was sealed under a key generation the daemon has since replaced.
 *
 * That copy cannot be opened by any key this tab can obtain, so merging into
 * it is impossible and keeping it is pointless: it is dropped and the pull
 * stands alone. Offline edits that were not yet sent go with it; they were
 * unreadable already, and the alternative was a pull that fails for good while
 * the copy goes on reading as damaged. Claim first, bytes second, as every
 * delete of a copy does, and the wrapped key goes too — it opens a key
 * generation that no longer matches anything on this device.
 */
async function openForMerge(
  workspaceDocs: WorkspaceDocs,
  workspaceId: string,
  daemonBaseUrl: string,
): Promise<LoroDoc> {
  try {
    return (await workspaceDocs.open(workspaceId)) ?? new LoroDoc()
  } catch (err) {
    if (!(err instanceof ReplicaKeyRotatedError)) throw err
    log.warn('replica sealed under a replaced key was dropped to pull it again', {
      daemonBaseUrl,
      workspaceId,
    })
    createUserSettingsStore().update((current) => forgetReplicaEntry(current, workspaceId))
    stopReplicaReadableOffline(daemonBaseUrl, workspaceId)
    await openDocumentStore().deleteDoc({ docRef: { kind: 'workspace-tree', workspaceId } })
    return new LoroDoc()
  }
}

export async function cacheDaemonWorkspace(
  options: CacheDaemonWorkspaceOptions,
): Promise<CacheDaemonWorkspaceResult> {
  const { fetch, daemonBaseUrl, workspaceId, workspaceDocs } = options
  // Marks the replica BEFORE the save below, not after: both callers (the
  // Settings move and the background refresh) register the settings-store
  // entry only once this function returns, so without this mark the FIRST
  // pull would land through `openDocumentStore`'s plaintext arm — sealed
  // only from the second pull on, once the registry entry exists.
  markReplica(workspaceId, daemonBaseUrl)
  try {
    const res = await fetch(`${daemonBaseUrl}${workspaceDocumentApiUrl(workspaceId, 'snapshot')}`)
    if (!res.ok) {
      return { kind: 'failed', reason: `Snapshot request failed (${res.status}).` }
    }
    const bytes = new Uint8Array(await res.arrayBuffer())
    const daemonOnly = new LoroDoc()
    daemonOnly.import(bytes)
    const doc = await openForMerge(workspaceDocs, workspaceId, daemonBaseUrl)
    doc.import(bytes)
    await workspaceDocs.save(workspaceId, doc)
    const held = replicaKeyStatus(daemonBaseUrl, workspaceId)
    return {
      kind: 'ok',
      ...(held?.kind === 'held' && held.keyId !== undefined ? { keyId: held.keyId } : {}),
      syncedAt: new Date().toISOString(),
      documentCount: readWorkspaceDocuments(doc).length,
      syncedFrontier: bytesToBase64(daemonOnly.oplogVersion().encode()),
    }
  } catch (err) {
    if (err instanceof ReplicaKeyWithheldError) return { kind: 'withheld' }
    // A thrown fetch (daemon offline mid-pull) surfaces as a structured
    // failure the caller can report; the pull is safe to re-run.
    return { kind: 'failed', reason: 'Could not reach the daemon (network error).' }
  }
}
