/**
 * ADR-0023 decision 2's second half: once a promoted workspace's replica
 * VERIFIABLY holds everything the move carried, the old browser record is
 * deleted — the replica is the local copy, so keeping the original would be
 * the frozen fork this decision exists to end.
 *
 * The gate is the caller's (every blob transferred, and `replicaCarriesAll`
 * against the replica read back from this browser's own store — never
 * against the response that was just imported, which proves only that the
 * network worked). What this module owns is the deletion's shape:
 *
 * - Only the workspace-keyed rows die: the record (the `workspace-tree`
 *   docRef) and the registry row. Planes keyed by DOCUMENT id — images,
 *   versions — are shared with the replica, whose documents kept their ids
 *   through the move, so deleting them would hollow out the very copy that
 *   justified the deletion.
 * - The registry is never left empty: `resolveBrowserWorkspaceId` throws on
 *   an empty registry (re-minting is an upgrade-time step), so deleting the
 *   last row would leave the browser keeper unbootable. A fresh empty
 *   workspace row is minted in the same transaction.
 * - The in-memory identity is re-pointed before returning, so a write that
 *   races the narrated reload lands in the fresh workspace instead of
 *   resurrecting the deleted record under its old id.
 */
import { readWorkspaceDocuments } from '@kamiazya/whiteboard-loro-adapter'
import { generateDocumentId } from '@kamiazya/whiteboard-model'
import { BROWSER_DEFAULT_SEGMENT, openWhiteboardDb, WORKSPACES_STORE } from './browser-idb.js'
import type { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import { switchBrowserWorkspace } from './browser-workspace-id.js'
import { IdbDocumentStore } from './idb-document-store.js'

/**
 * Does the replica this browser stores under the DAEMON workspace id hold
 * every document the move reported? Read back from IndexedDB on purpose.
 */
export async function replicaCarriesAll(
  workspaceDocs: BrowserWorkspaceDocs,
  daemonWorkspaceId: string,
  documentIds: readonly string[],
): Promise<boolean> {
  const record = await workspaceDocs.open(daemonWorkspaceId)
  if (record === null) return false
  const held = new Set(readWorkspaceDocuments(record).map((entry) => entry.documentId))
  return documentIds.every((id) => held.has(id))
}

export async function demoteBrowserWorkspace(
  sourceWorkspaceId: string,
  dbName?: string,
): Promise<void> {
  // Registry first, record last — the two cannot share a transaction (the
  // record deletion owns its own), so the ORDER decides what a failure in
  // between leaves behind. This way it is an orphaned record with no
  // registry row: unreachable, harmless garbage. The other order leaves a
  // registry row whose record is gone — a workspace that lists but opens
  // empty, which reads as data loss.
  const db = await openWhiteboardDb(dbName)
  let nextHandle: string
  try {
    nextHandle = await new Promise<string>((resolve, reject) => {
      const tx = db.transaction([WORKSPACES_STORE], 'readwrite')
      const workspaces = tx.objectStore(WORKSPACES_STORE)
      workspaces.delete(sourceWorkspaceId)
      const keysReq = workspaces.getAllKeys()
      let chosen: string | undefined
      keysReq.onsuccess = () => {
        const remaining = keysReq.result.map(String)
        chosen = remaining[0]
        if (chosen === undefined) {
          const fresh = generateDocumentId()
          workspaces.put({ workspaceId: fresh, segment: BROWSER_DEFAULT_SEGMENT }, fresh)
          chosen = fresh
        }
      }
      tx.oncomplete = () => {
        if (chosen === undefined) reject(new Error('workspace registry read never settled'))
        else resolve(chosen)
      }
      tx.onerror = () => reject(tx.error ?? new Error('workspace registry update failed'))
      tx.onabort = () => reject(tx.error ?? new Error('workspace registry update aborted'))
    })
  } finally {
    db.close()
  }
  await switchBrowserWorkspace(nextHandle, dbName)
  try {
    await new IdbDocumentStore(dbName).deleteDoc({
      docRef: { kind: 'workspace-tree', workspaceId: sourceWorkspaceId },
    })
  } catch {
    // The demotion already stands: with the registry row gone the record is
    // unreachable, so a failed byte deletion is lingering garbage, not a
    // half-demoted workspace — and not worth failing the report over.
  }
}
