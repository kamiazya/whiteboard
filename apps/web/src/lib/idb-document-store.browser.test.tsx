/**
 * The browser `DocumentStore`, held to the port's own conformance suite — the
 * same one the daemon's libSQL and in-memory stores pass, so a document's sync
 * state means one thing across all three.
 *
 * Nothing is asserted here beyond the contract. What this file adds is the
 * IndexedDB-specific fixture: a real database per case, deleted afterwards,
 * because every conformance case assumes a store that starts empty.
 */
import type { DocRef } from '@kamiazya/whiteboard-ports'
import { chunkSnapshot, docRefKey } from '@kamiazya/whiteboard-ports'
import { describeDocumentStoreConformance } from '@kamiazya/whiteboard-ports/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SYNC_DOCUMENTS_STORE } from './browser-idb.js'
import { IdbDocumentStore } from './idb-document-store.js'

// Its OWN database, not the app's — browser tests share an origin, so deleting
// `whiteboard` between cases would tear it out from under whatever other file
// is mid-fixture, and the failure would land there.
const DB_NAME = 'whiteboard-document-store-conformance'

async function deleteDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME)
    // No `onblocked` resolve: `blocked` means the delete has NOT happened yet,
    // so resolving there starts the next case against the previous one's rows.
    // `IdbDocumentStore` closes its connection in a `finally`, so nothing this
    // suite opens outlives its own call.
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

describe('IdbDocumentStore', () => {
  describeDocumentStoreConformance(async () => {
    await deleteDb()
    const store = new IdbDocumentStore(DB_NAME)
    return {
      store,
      dispose: deleteDb,
      writeUnreadableRecord: (docRef) => store.writeUnreadableRecord(docRef),
    }
  })
})

/**
 * The storage LAYOUT, which the conformance suite deliberately says nothing
 * about — it judges what a store answers, not what it writes.
 *
 * What is pinned here is the one layout fact the port cannot express and this
 * store's cost depends on: a snapshot's bytes are not inside the record that
 * also holds the delta log. `appendDeltas` reads that record on every edit, so
 * inlining the chunks makes the cost of appending 88 bytes proportional to the
 * size of the whole document.
 */
describe('IdbDocumentStore layout', () => {
  const docRef: DocRef = { kind: 'document', documentId: '01JD000000000000000000000A' }

  function openRaw(version?: number): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = version === undefined ? indexedDB.open(DB_NAME) : indexedDB.open(DB_NAME, version)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(SYNC_DOCUMENTS_STORE)) {
          db.createObjectStore(SYNC_DOCUMENTS_STORE)
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }

  async function withRaw<T>(body: (db: IDBDatabase) => Promise<T>, version?: number): Promise<T> {
    const db = await openRaw(version)
    try {
      return await body(db)
    } finally {
      db.close()
    }
  }

  function get(db: IDBDatabase, store: string, key: IDBValidKey): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const req = db.transaction([store], 'readonly').objectStore(store).get(key)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }

  function put(db: IDBDatabase, store: string, value: unknown, key: IDBValidKey): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = db.transaction([store], 'readwrite')
      tx.objectStore(store).put(value, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error ?? new Error('aborted'))
    })
  }

  beforeEach(deleteDb)
  afterEach(deleteDb)

  it('keeps snapshot bytes out of the record the delta log lives in', async () => {
    const store = new IdbDocumentStore(DB_NAME)
    const bytes = new Uint8Array(4096).fill(7)
    const { manifest, chunks } = chunkSnapshot(bytes, 1024)
    await store.saveSnapshot({ docRef, manifest, chunks, frontier: new Uint8Array([1]) })

    const record = await withRaw((db) => get(db, SYNC_DOCUMENTS_STORE, docRefKey(docRef)))
    const snapshot = (record as { snapshot: Record<string, unknown> }).snapshot
    // Written out as the exact key set rather than `chunks === undefined`:
    // `toEqual` treats an absent key and an `undefined` one alike, and the
    // whole claim is that the bytes are not in this value at all.
    expect(Object.keys(snapshot)).toEqual(['manifest'])
  })

  it('carries a pre-split record with inline chunks out to the chunk store', async () => {
    const bytes = Uint8Array.from({ length: 3000 }, (_, i) => i % 251)
    const { manifest, chunks } = chunkSnapshot(bytes, 1024)
    await withRaw(
      (db) =>
        put(
          db,
          SYNC_DOCUMENTS_STORE,
          { v: 1, snapshot: { manifest, chunks }, frontier: new Uint8Array([9]), deltas: [] },
          docRefKey(docRef),
        ),
      12,
    )

    const loaded = await new IdbDocumentStore(DB_NAME).loadSnapshot({ docRef })
    expect(loaded?.manifest).toEqual(manifest)
    expect(loaded?.chunks.map((chunk) => [...chunk.bytes])).toEqual(
      chunks.map((chunk) => [...chunk.bytes]),
    )
  })
})
