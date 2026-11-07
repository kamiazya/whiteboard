import { docRefKey } from '@kamiazya/whiteboard-ports'
import { DOCUMENT_FILES_STORE, SYNC_DOCUMENTS_STORE } from '../lib/browser-idb.js'
import { inTransaction, request } from '../lib/idb-tx.js'

/**
 * Writes one raw row into the sync store, bypassing every store that would
 * parse it, so a test can prove the build REFUSES a shape it no longer reads
 * and leaves it as written. No production path writes either shape any more.
 */
export async function putRawSyncRow(key: string, value: unknown, dbName?: string): Promise<void> {
  await inTransaction(dbName, [SYNC_DOCUMENTS_STORE], 'readwrite', async (tx) => {
    await request(tx.objectStore(SYNC_DOCUMENTS_STORE).put(value, key))
  })
}

/** A per-document content record (`document:<id>`), the pre-tree shape. */
export function seedPreTreeContentRow(documentId: string, dbName?: string): Promise<void> {
  return putRawSyncRow(
    docRefKey({ kind: 'document', workspaceId: 'unused', documentId }),
    { v: 3, snapshot: null, frontier: null, deltas: [], generation: 0, nextSeq: 1 },
    dbName,
  )
}

/** The v2 sync envelope, under the browser workspace's tree key. */
export function seedRetiredEnvelope(workspaceId: string, dbName?: string): Promise<void> {
  return putRawSyncRow(
    docRefKey({ kind: 'workspace-tree', workspaceId }),
    { v: 2, snapshot: null, frontier: null, deltas: [] },
    dbName,
  )
}

/** The `v: 1` file record, which held the Blob itself, under a fileId. */
export async function seedRetiredFileRecord(
  fileId: string,
  bytes: Uint8Array<ArrayBuffer>,
  dbName?: string,
): Promise<void> {
  await inTransaction(dbName, [DOCUMENT_FILES_STORE], 'readwrite', async (tx) => {
    await request(
      tx
        .objectStore(DOCUMENT_FILES_STORE)
        .put({ v: 1, mimeType: 'image/png', created: 1, blob: new Blob([bytes]) }, fileId),
    )
  })
}
