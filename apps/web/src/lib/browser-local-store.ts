import { openWhiteboardDb } from './browser-idb.js'
import type { DocumentSnapshot } from './whiteboard-client.js'
import { documentSnapshotSchema } from './whiteboard-client.js'

export type LoadResult =
  | { kind: 'ok'; snapshot: DocumentSnapshot }
  | { kind: 'not-found' }
  | { kind: 'corrupted' }

export type DeleteResult =
  | { deleted: true }
  | { deleted: false; reason: 'pointer-mismatch' | 'not-found' }

export interface BrowserLocalStore {
  getDefaultDocumentId(): Promise<string | null>
  setDefaultDocumentId(id: string): Promise<void>
  load(id: string): Promise<LoadResult>
  save(snapshot: DocumentSnapshot): Promise<void>
  del(expectedId: string): Promise<DeleteResult>
  // Unconditional delete of a canvas record by id, independent of the default pointer.
  // Optional capability used for best-effort cleanup of records del() cannot reach
  // (it only removes the canvas the default pointer currently aims at).
  removeDocument?(id: string): Promise<void>
  generateId(): string
  listDocuments(): Promise<DocumentSnapshot[]>
}

export class MemoryStore implements BrowserLocalStore {
  private defaultId: string | null = null
  private documents = new Map<string, DocumentSnapshot>()

  async getDefaultDocumentId(): Promise<string | null> {
    return this.defaultId
  }

  async setDefaultDocumentId(id: string): Promise<void> {
    this.defaultId = id
  }

  async load(id: string): Promise<LoadResult> {
    const snapshot = this.documents.get(id)
    if (!snapshot) return { kind: 'not-found' }
    return { kind: 'ok', snapshot }
  }

  async save(snapshot: DocumentSnapshot): Promise<void> {
    this.documents.set(snapshot.id, snapshot)
  }

  async del(expectedId: string): Promise<DeleteResult> {
    if (this.defaultId === null) return { deleted: false, reason: 'not-found' }
    if (this.defaultId !== expectedId) return { deleted: false, reason: 'pointer-mismatch' }
    this.documents.delete(expectedId)
    this.defaultId = null
    return { deleted: true }
  }

  async removeDocument(id: string): Promise<void> {
    this.documents.delete(id)
  }

  generateId(): string {
    return crypto.randomUUID()
  }

  async listDocuments(): Promise<DocumentSnapshot[]> {
    return [...this.documents.values()]
  }
}

export class IndexedDBStore implements BrowserLocalStore {
  async getDefaultDocumentId(): Promise<string | null> {
    const db = await openWhiteboardDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('meta', 'readonly')
      const req = tx.objectStore('meta').get('defaultDocumentId')
      req.onsuccess = () => resolve((req.result as string | undefined) ?? null)
      req.onerror = () => reject(req.error)
      tx.oncomplete = () => db.close()
    })
  }

  async setDefaultDocumentId(id: string): Promise<void> {
    const db = await openWhiteboardDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('meta', 'readwrite')
      tx.objectStore('meta').put(id, 'defaultDocumentId')
      tx.oncomplete = () => {
        db.close()
        resolve()
      }
      tx.onerror = () => reject(tx.error)
      // Without onabort a mid-write abort (e.g. QuotaExceeded) leaves the promise
      // unsettled — the caller's await would hang forever.
      tx.onabort = () => {
        db.close()
        reject(tx.error ?? new Error('transaction aborted'))
      }
    })
  }

  async load(id: string): Promise<LoadResult> {
    const db = await openWhiteboardDb()
    return new Promise((resolve) => {
      const tx = db.transaction('documents', 'readonly')
      const req = tx.objectStore('documents').get(id)
      req.onsuccess = () => {
        if (req.result === undefined) {
          resolve({ kind: 'not-found' })
          return
        }
        const parsed = documentSnapshotSchema.safeParse(req.result)
        resolve(parsed.success ? { kind: 'ok', snapshot: parsed.data } : { kind: 'corrupted' })
      }
      req.onerror = () => resolve({ kind: 'corrupted' })
      tx.oncomplete = () => db.close()
    })
  }

  async save(snapshot: DocumentSnapshot): Promise<void> {
    const db = await openWhiteboardDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('documents', 'readwrite')
      tx.objectStore('documents').put(snapshot, snapshot.id)
      tx.oncomplete = () => {
        db.close()
        resolve()
      }
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => {
        db.close()
        reject(tx.error ?? new Error('transaction aborted'))
      }
    })
  }

  async del(expectedId: string): Promise<DeleteResult> {
    const db = await openWhiteboardDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['meta', 'documents'], 'readwrite')
      const metaStore = tx.objectStore('meta')
      const documentStore = tx.objectStore('documents')
      let earlyResult: DeleteResult | null = null

      const getReq = metaStore.get('defaultDocumentId')
      getReq.onsuccess = () => {
        const current = (getReq.result as string | undefined) ?? null
        if (current === null) {
          earlyResult = { deleted: false, reason: 'not-found' }
          tx.abort()
          return
        }
        if (current !== expectedId) {
          earlyResult = { deleted: false, reason: 'pointer-mismatch' }
          tx.abort()
          return
        }
        metaStore.delete('defaultDocumentId')
        documentStore.delete(expectedId)
      }
      tx.oncomplete = () => {
        db.close()
        resolve({ deleted: true })
      }
      tx.onabort = () => {
        db.close()
        // earlyResult is set only when our code calls tx.abort() (pointer-mismatch / not-found).
        // An abort without earlyResult is an unexpected engine failure — reject so callers can surface it.
        if (earlyResult !== null) resolve(earlyResult)
        else reject(tx.error ?? new DOMException('Transaction aborted unexpectedly', 'AbortError'))
      }
      tx.onerror = () => {
        db.close()
        reject(tx.error)
      }
    })
  }

  async removeDocument(id: string): Promise<void> {
    const db = await openWhiteboardDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('documents', 'readwrite')
      tx.objectStore('documents').delete(id)
      tx.oncomplete = () => {
        db.close()
        resolve()
      }
      tx.onerror = () => {
        db.close()
        reject(tx.error)
      }
      tx.onabort = () => {
        db.close()
        reject(tx.error ?? new Error('transaction aborted'))
      }
    })
  }

  generateId(): string {
    return crypto.randomUUID()
  }

  async listDocuments(): Promise<DocumentSnapshot[]> {
    const db = await openWhiteboardDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('documents', 'readonly')
      const cursorReq = tx.objectStore('documents').openCursor()
      const results: DocumentSnapshot[] = []
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result
        if (!cursor) return
        // Hydrate through the single parse boundary; skip a corrupt/legacy row
        // instead of throwing so it cannot blank the whole list.
        const parsed = documentSnapshotSchema.safeParse(cursor.value)
        if (parsed.success) results.push(parsed.data)
        cursor.continue()
      }
      cursorReq.onerror = () => reject(cursorReq.error)
      tx.oncomplete = () => {
        db.close()
        resolve(results)
      }
      tx.onerror = () => {
        db.close()
        reject(tx.error)
      }
      tx.onabort = () => {
        db.close()
        reject(tx.error ?? new Error('transaction aborted'))
      }
    })
  }
}
