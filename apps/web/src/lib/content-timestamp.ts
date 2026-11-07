/**
 * The listing clock: when a document's content was last written, the browser
 * listing's `updatedAt` source. Standalone because the writers that stamp it
 * (the workspace-document write path, create, import, linkify) share no store
 * to hang it on — see `CONTENT_TIMESTAMPS_STORE`.
 */
import { CONTENT_TIMESTAMPS_STORE } from './browser-idb.js'
import { inTransaction, request } from './idb-tx.js'

/**
 * Record when a document's content was last written. Best-effort: a listing
 * that shows the epoch is worse than one that shows the truth, but neither is
 * worth failing a save the user's document depends on.
 */
export async function touchContentTimestamp(documentId: string, dbName?: string): Promise<void> {
  try {
    await inTransaction(dbName, [CONTENT_TIMESTAMPS_STORE], 'readwrite', async (tx) => {
      await request(
        tx.objectStore(CONTENT_TIMESTAMPS_STORE).put(new Date().toISOString(), documentId),
      )
    })
  } catch {
    // Intentionally swallowed; see above.
  }
}

/**
 * Drops a document's listing clock once no copy of it is left to date — a
 * purge, or a demote's residue. Best-effort for the reason the stamp is: an
 * orphan stamp is invisible, since a listing only reads the stamps of
 * documents it lists.
 */
export async function forgetContentTimestamp(documentId: string, dbName?: string): Promise<void> {
  try {
    await inTransaction(dbName, [CONTENT_TIMESTAMPS_STORE], 'readwrite', async (tx) => {
      await request(tx.objectStore(CONTENT_TIMESTAMPS_STORE).delete(documentId))
    })
  } catch {
    // Intentionally swallowed; see above.
  }
}
