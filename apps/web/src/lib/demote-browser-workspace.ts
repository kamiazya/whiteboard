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
 * - The row's deletion writes a tombstone in the same transaction
 *   (`workspace-tombstone.ts`). Re-pointing this tab's identity covers this
 *   tab alone; another tab's open page keeps the whole record in memory under
 *   the old id, and to every writer a missing record means "never created",
 *   so its next save or create would mint the workspace again. The
 *   tombstone is what those writers refuse on, and every open page is told
 *   at once (`workspace-removed`), so it locks instead of waiting for a
 *   keystroke to find out.
 */
import {
  readTrashEntries,
  readWorkspaceDocuments,
  type TrashEntry,
} from '@kamiazya/whiteboard-loro-adapter'
import { generateDocumentId } from '@kamiazya/whiteboard-model'
import { getAppLogger } from './app-logger.js'
import { BROWSER_DEFAULT_SEGMENT, WORKSPACES_STORE } from './browser-idb.js'
import { deleteVersionRowsOfWorkspace } from './browser-version-store.js'
import { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import { switchBrowserWorkspace } from './browser-workspace-id.js'
import { IdbBlobStore } from './idb-blob-store.js'
import { inTransaction, request } from './idb-tx.js'
import { forgetContentTimestamp } from './loro-store.js'
import { openDocumentStore } from './replica-store.js'
import { announceWorkspaceRemoved } from './workspace-broadcast.js'
import { TOMBSTONE_STORE, writeTombstone } from './workspace-tombstone.js'

const log = getAppLogger('demote-browser-workspace')

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
  const { nextHandle, remaining } = await dropRegistryRow(sourceWorkspaceId, dbName)
  announceWorkspaceRemoved(sourceWorkspaceId)
  await switchBrowserWorkspace(nextHandle, dbName)
  await bestEffort(sourceWorkspaceId, 'record', () =>
    openDocumentStore(dbName).deleteDoc({
      docRef: { kind: 'workspace-tree', workspaceId: sourceWorkspaceId },
    }),
  )
  // Keyed by the source id alone, so a record that will not open does not keep them.
  await bestEffort(sourceWorkspaceId, 'version rows', () =>
    deleteVersionRowsOfWorkspace(sourceWorkspaceId, dbName),
  )
  if (residue !== null) await discardResidue(sourceWorkspaceId, residue, remaining, dbName)
}

/**
 * One deletion after the demotion already stands. A failure leaves
 * unreachable garbage rather than a half-demoted workspace, so it does not
 * fail the move — but nothing can name that garbage again, so it is said.
 */
async function bestEffort(
  workspaceId: string,
  step: string,
  run: () => Promise<void>,
): Promise<void> {
  try {
    await run()
  } catch (err) {
    log.warn(`demote left the moved workspace's ${step} behind`, { workspaceId, step, err })
  }
}

/**
 * Deletes the source's registry row, minting a fresh workspace row when it
 * was the last, and answers the handle to re-point at plus the rows that
 * remain — the browser-kept workspaces whose trash may still name a blob.
 */
function dropRegistryRow(
  sourceWorkspaceId: string,
  dbName?: string,
): Promise<{ nextHandle: string; remaining: readonly string[] }> {
  const stores = [WORKSPACES_STORE, TOMBSTONE_STORE]
  return inTransaction(dbName, stores, 'readwrite', async (tx) => {
    const workspaces = tx.objectStore(WORKSPACES_STORE)
    workspaces.delete(sourceWorkspaceId)
    writeTombstone(tx, sourceWorkspaceId)
    const remaining = (await request(workspaces.getAllKeys())).map(String)
    const kept = remaining[0]
    if (kept !== undefined) return { nextHandle: kept, remaining }
    const fresh = generateDocumentId()
    workspaces.put({ workspaceId: fresh, segment: BROWSER_DEFAULT_SEGMENT }, fresh)
    return { nextHandle: fresh, remaining }
  })
}

/** What only the source record names, read before the record goes. */
interface Residue {
  readonly trash: readonly TrashEntry[]
  readonly documentIds: readonly string[]
}

async function residueOf(workspaceId: string, dbName?: string): Promise<Residue | null> {
  // Unreadable means unjudgeable: leave what only the record names rather
  // than guess at it — and say so, since nothing can name it afterwards.
  const record = await new BrowserWorkspaceDocs(dbName).open(workspaceId).catch((err: unknown) => {
    log.warn(
      "demote left the moved workspace's trash bytes and listing clocks: its record could not be read",
      { workspaceId, err },
    )
    return null
  })
  if (record === null) return null
  const trash = readTrashEntries(record)
  const live = readWorkspaceDocuments(record).map((entry) => entry.documentId)
  return { trash, documentIds: [...live, ...trash.map((entry) => entry.documentId)] }
}

/**
 * What only the record names, each kind on its own boundary, because only the
 * trash bytes depend on the neighbours: the clocks are keyed by document ids
 * no other workspace holds.
 */
async function discardResidue(
  sourceWorkspaceId: string,
  residue: Residue,
  remainingWorkspaceIds: readonly string[],
  dbName?: string,
): Promise<void> {
  // Only a browser-kept workspace's listing reads these clocks, and a
  // document id is minted once, so no remaining one lists these ids.
  await bestEffort(sourceWorkspaceId, 'listing clocks', async () => {
    for (const id of residue.documentIds) await forgetContentTimestamp(id, dbName)
  })
  await bestEffort(sourceWorkspaceId, 'trash blobs', async () => {
    const named = await trashBlobsNamedBy(remainingWorkspaceIds, dbName)
    const blobs = new IdbBlobStore(dbName)
    for (const entry of residue.trash) {
      if (!named.has(entry.blob.digestHex)) await blobs.delete({ ref: entry.blob })
    }
  })
}

/**
 * Every trash digest the remaining workspaces name. A neighbour that will
 * not open throws, so no blob is deleted: what it names is unknown.
 */
async function trashBlobsNamedBy(
  workspaceIds: readonly string[],
  dbName?: string,
): Promise<Set<string>> {
  const docs = new BrowserWorkspaceDocs(dbName)
  const named = new Set<string>()
  for (const workspaceId of workspaceIds) {
    const record = await docs.open(workspaceId)
    if (record === null) continue
    for (const entry of readTrashEntries(record)) named.add(entry.blob.digestHex)
  }
  return named
}
