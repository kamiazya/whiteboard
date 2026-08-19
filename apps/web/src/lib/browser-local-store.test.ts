import { documentIdSchema } from '@kamiazya/whiteboard-model'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import { DB_VERSION } from './browser-idb.js'
import { IndexedDBStore, MemoryStore } from './browser-local-store.js'
import type { DocumentSnapshot } from './whiteboard-client.js'

const snap: DocumentSnapshot = {
  documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  workspaceId: 'local',
  path: 'untitled',
  name: 'untitled',
  updatedAt: '2026-05-24T00:00:00.000Z',
  kind: 'spatial' as const,
}
const ID = snap.documentId
const ID_B = '01ARZ3NDEKTSV4RRFFQ69G5FB0'

// Both stores mint the same kind of id, and it is the daemon's kind: a
// `crypto.randomUUID()` parses as a string but `documentIdSchema` refuses it,
// so a local document could never be named in a `DocRef`.
describe.each([
  ['MemoryStore', () => new MemoryStore()],
  ['IndexedDBStore', () => new IndexedDBStore()],
])('%s generateId', (_name, make) => {
  it('mints a document id the rest of the system accepts', () => {
    expect(() => documentIdSchema.parse(make().generateId())).not.toThrow()
  })
})

describe('MemoryStore', () => {
  it('load returns not-found for unknown id', async () => {
    const store = new MemoryStore()
    expect(await store.load(ID)).toEqual({ kind: 'not-found' })
  })

  it('save then load returns ok with snapshot', async () => {
    const store = new MemoryStore()
    await store.save(snap)
    expect(await store.load(ID)).toEqual({ kind: 'ok', snapshot: snap })
  })

  it('getDefaultDocumentId returns null initially', async () => {
    const store = new MemoryStore()
    expect(await store.getDefaultDocumentId()).toBeNull()
  })

  it('setDefaultDocumentId then get returns the set id', async () => {
    const store = new MemoryStore()
    await store.setDefaultDocumentId(ID)
    expect(await store.getDefaultDocumentId()).toBe(ID)
  })

  it('del with matching id deletes canvas and clears pointer', async () => {
    const store = new MemoryStore()
    await store.setDefaultDocumentId(ID)
    await store.save(snap)
    expect(await store.del(ID)).toEqual({ deleted: true })
    expect(await store.load(ID)).toEqual({ kind: 'not-found' })
    expect(await store.getDefaultDocumentId()).toBeNull()
  })

  it('del with pointer-mismatch returns not-deleted', async () => {
    const store = new MemoryStore()
    await store.setDefaultDocumentId(ID_B)
    await store.save(snap)
    expect(await store.del(ID)).toEqual({ deleted: false, reason: 'pointer-mismatch' })
  })

  it('del when no default id returns not-found', async () => {
    const store = new MemoryStore()
    expect(await store.del(ID)).toEqual({ deleted: false, reason: 'not-found' })
  })

  it('removeDocument deletes a record by id without matching the default pointer', async () => {
    const store = new MemoryStore()
    const a: DocumentSnapshot = { ...snap }
    const b: DocumentSnapshot = { ...snap, documentId: ID_B, path: 'untitled-2' }
    await store.save(a)
    await store.save(b)
    await store.setDefaultDocumentId(ID)

    await store.removeDocument(ID_B)

    expect(await store.load(ID_B)).toEqual({ kind: 'not-found' })
    expect(await store.load(ID)).toEqual({ kind: 'ok', snapshot: a })
    expect(await store.getDefaultDocumentId()).toBe(ID)
  })

  it('removeDocument on a non-existent id is a no-op', async () => {
    const store = new MemoryStore()
    await store.save(snap)
    await store.setDefaultDocumentId(ID)

    await expect(store.removeDocument('missing')).resolves.toBeUndefined()

    expect(await store.load(ID)).toEqual({ kind: 'ok', snapshot: snap })
    expect(await store.getDefaultDocumentId()).toBe(ID)
  })

  it('generateId returns a non-empty string each call', () => {
    const store = new MemoryStore()
    const a = store.generateId()
    const b = store.generateId()
    expect(typeof a).toBe('string')
    expect(a.length).toBeGreaterThan(0)
    expect(a).not.toBe(b)
  })

  it('listDocuments returns empty array when store is empty', async () => {
    const store = new MemoryStore()
    expect(await store.listDocuments()).toEqual([])
  })

  it('listDocuments returns all saved snapshots by id', async () => {
    const store = new MemoryStore()
    const a: DocumentSnapshot = { ...snap, name: 'Canvas A' }
    const b: DocumentSnapshot = { ...snap, documentId: ID_B, path: 'untitled-2', name: 'Canvas B' }
    await store.save(a)
    await store.save(b)
    const list = await store.listDocuments()
    expect(list).toHaveLength(2)
    expect(list).toEqual(expect.arrayContaining([a, b]))
  })
})

describe('IndexedDBStore', () => {
  beforeEach(() => {
    // Fresh IDB factory per test for isolation
    globalThis.indexedDB = new IDBFactory()
  })

  it('getDefaultDocumentId returns null initially', async () => {
    const store = new IndexedDBStore()
    expect(await store.getDefaultDocumentId()).toBeNull()
  })

  it('setDefaultDocumentId then get returns the set id', async () => {
    const store = new IndexedDBStore()
    await store.setDefaultDocumentId(ID)
    expect(await store.getDefaultDocumentId()).toBe(ID)
  })

  it('load returns not-found for unknown id', async () => {
    const store = new IndexedDBStore()
    expect(await store.load(ID)).toEqual({ kind: 'not-found' })
  })

  it('save then load returns ok with snapshot', async () => {
    const store = new IndexedDBStore()
    await store.save(snap)
    expect(await store.load(ID)).toEqual({ kind: 'ok', snapshot: snap })
  })

  it('load returns corrupted for malformed stored data', async () => {
    // Write garbage directly via raw IDB
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('whiteboard', 1)
      req.onupgradeneeded = (e) => {
        const db = (e.target as IDBOpenDBRequest).result
        db.createObjectStore('meta')
        db.createObjectStore('documents')
      }
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction('documents', 'readwrite')
        tx.objectStore('documents').put({ broken: true }, ID)
        tx.oncomplete = () => {
          db.close()
          resolve()
        }
        tx.onerror = () => reject(tx.error)
      }
      req.onerror = () => reject(req.error)
    })
    const store = new IndexedDBStore()
    expect(await store.load(ID)).toEqual({ kind: 'corrupted' })
  })

  it('del with matching id deletes canvas and clears pointer', async () => {
    const store = new IndexedDBStore()
    await store.setDefaultDocumentId(ID)
    await store.save(snap)
    expect(await store.del(ID)).toEqual({ deleted: true })
    expect(await store.load(ID)).toEqual({ kind: 'not-found' })
    expect(await store.getDefaultDocumentId()).toBeNull()
  })

  it('del with pointer-mismatch returns not-deleted', async () => {
    const store = new IndexedDBStore()
    await store.setDefaultDocumentId(ID_B)
    await store.save(snap)
    expect(await store.del(ID)).toEqual({ deleted: false, reason: 'pointer-mismatch' })
  })

  it('del when no default id returns not-found', async () => {
    const store = new IndexedDBStore()
    expect(await store.del(ID)).toEqual({ deleted: false, reason: 'not-found' })
  })

  it('listDocuments returns empty array when store is empty', async () => {
    const store = new IndexedDBStore()
    expect(await store.listDocuments()).toEqual([])
  })

  it('listDocuments returns all saved snapshots by id', async () => {
    const store = new IndexedDBStore()
    const a: DocumentSnapshot = { ...snap, name: 'Canvas A' }
    const b: DocumentSnapshot = { ...snap, documentId: ID_B, path: 'untitled-2', name: 'Canvas B' }
    await store.save(a)
    await store.save(b)
    const list = await store.listDocuments()
    expect(list).toHaveLength(2)
    expect(list).toEqual(expect.arrayContaining([a, b]))
  })

  it('listDocuments skips a corrupt row instead of throwing or blanking the list', async () => {
    const store = new IndexedDBStore()
    const a: DocumentSnapshot = { ...snap, name: 'Canvas A' }
    await store.save(a)
    // Write a malformed row directly via raw IDB (bypasses documentSnapshotSchema).
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('whiteboard', DB_VERSION)
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction('documents', 'readwrite')
        tx.objectStore('documents').put({ broken: true }, 'corrupt')
        tx.oncomplete = () => {
          db.close()
          resolve()
        }
        tx.onerror = () => reject(tx.error)
      }
      req.onerror = () => reject(req.error)
    })
    const list = await store.listDocuments()
    expect(list).toEqual([a])
  })
})
