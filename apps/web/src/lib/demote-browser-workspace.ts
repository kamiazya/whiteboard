/**
 * ADR-0023 decision 2's second half: once a promoted workspace's replica
 * VERIFIABLY holds everything the move carried, the old browser record is
 * deleted — the replica is the local copy, so keeping the original would be
 * the frozen fork this decision exists to end.
 *
 * The gate is the caller's, and it asks the KEEPER, never this browser's own
 * leftovers: every image transferred, every trash entry's bytes and every
 * saved version the daemon reports holding after it stored them (the
 * promotion's `leftBehind` is empty), and `replicaCarriesAll` against the
 * replica read back from this browser's own store — never against the
 * response that was just imported, which proves only that the network
 * worked. What this module owns is the deletion's shape:
 *
 * - The record (the `workspace-tree` docRef) and the registry row die, and so
 *   does everything only that record made reachable: each trash entry's
 *   evacuated bytes, the saved version rows keyed by the workspace, and the
 *   listing clock of every document it held. Nothing a replica opens reads
 *   any of them — its pages ask the daemon — and once the record is gone no
 *   purge, sweep or Settings surface can name them again, so whatever this
 *   step leaves stays for the life of the origin. Images need nothing here:
 *   the file sweep drops them once no remaining record names them.
 * - A trash blob survives while another browser-kept workspace's trash still
 *   names it — the blob store is content-addressed and global, and that rule
 *   is the one `purgeTrashEntry` applies within a workspace. The store's other
 *   owners cannot share a trash digest: pictures are image encodings, and a
 *   replica's envelopes are sealed under a fresh IV.
 * - The residue goes AFTER the record, best-effort: by then the demotion
 *   stands, and a failure leaves unreachable garbage rather than a
 *   half-demoted workspace.
 * - The registry is never left empty: `resolveBrowserWorkspaceId` throws on
 *   an empty registry (re-minting is an upgrade-time step), so deleting the
 *   last row would leave the browser keeper unbootable. A fresh empty
 *   workspace row is minted in the same transaction.
 * - The in-memory identity is re-pointed before returning, so a write that
 *   races the narrated reload lands in the fresh workspace instead of
 *   resurrecting the deleted record under its old id.
 */
import {
  readTrashEntries,
  readWorkspaceDocuments,
  type TrashEntry,
} from '@kamiazya/whiteboard-loro-adapter'
import { generateDocumentId } from '@kamiazya/whiteboard-model'
import { BROWSER_DEFAULT_SEGMENT, openWhiteboardDb, WORKSPACES_STORE } from './browser-idb.js'
import { deleteVersionRowsOfWorkspace } from './browser-version-store.js'
import { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import { switchBrowserWorkspace } from './browser-workspace-id.js'
import { IdbBlobStore } from './idb-blob-store.js'
import { forgetContentTimestamp } from './loro-store.js'
import { openDocumentStore } from './replica-store.js'

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
  const residue = await residueOf(sourceWorkspaceId, dbName)
  const db = await openWhiteboardDb(dbName)
  let nextHandle: string
  let remaining: readonly string[] = []
  try {
    nextHandle = await new Promise<string>((resolve, reject) => {
      const tx = db.transaction([WORKSPACES_STORE], 'readwrite')
      const workspaces = tx.objectStore(WORKSPACES_STORE)
      workspaces.delete(sourceWorkspaceId)
      const keysReq = workspaces.getAllKeys()
      let chosen: string | undefined
      keysReq.onsuccess = () => {
        remaining = keysReq.result.map(String)
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
    await openDocumentStore(dbName).deleteDoc({
      docRef: { kind: 'workspace-tree', workspaceId: sourceWorkspaceId },
    })
  } catch {
    // The demotion already stands: with the registry row gone the record is
    // unreachable, so a failed byte deletion is lingering garbage, not a
    // half-demoted workspace — and not worth failing the report over.
  }
  if (residue !== null) await discardResidue(sourceWorkspaceId, residue, remaining, dbName)
}

/** What only the source record names, read before the record goes. */
interface Residue {
  readonly trash: readonly TrashEntry[]
  readonly documentIds: readonly string[]
}

async function residueOf(workspaceId: string, dbName?: string): Promise<Residue | null> {
  // Unreadable means unjudgeable: leave the residue rather than guess at it.
  const record = await new BrowserWorkspaceDocs(dbName).open(workspaceId).catch(() => null)
  if (record === null) return null
  const trash = readTrashEntries(record)
  const live = readWorkspaceDocuments(record).map((entry) => entry.documentId)
  return { trash, documentIds: [...live, ...trash.map((entry) => entry.documentId)] }
}

async function discardResidue(
  sourceWorkspaceId: string,
  residue: Residue,
  remainingWorkspaceIds: readonly string[],
  dbName?: string,
): Promise<void> {
  try {
    const docs = new BrowserWorkspaceDocs(dbName)
    const namedBlobs = new Set<string>()
    for (const workspaceId of remainingWorkspaceIds) {
      // A neighbour that will not open throws, and the catch below then
      // deletes nothing: what it names is unknown.
      const record = await docs.open(workspaceId)
      if (record === null) continue
      for (const entry of readTrashEntries(record)) namedBlobs.add(entry.blob.digestHex)
    }
    await deleteVersionRowsOfWorkspace(sourceWorkspaceId, dbName)
    const blobs = new IdbBlobStore(dbName)
    for (const entry of residue.trash) {
      if (!namedBlobs.has(entry.blob.digestHex)) await blobs.delete({ ref: entry.blob })
    }
    // Only a browser-kept workspace's listing reads these clocks, and a
    // document id is minted once, so no remaining one lists these ids.
    for (const id of residue.documentIds) await forgetContentTimestamp(id, dbName)
  } catch {
    // Same standing as the record's deletion above: the demotion stands, and
    // what is left is unreachable garbage, not a reason to fail the move.
  }
}
