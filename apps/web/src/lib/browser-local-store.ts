import { z } from 'zod'
import type { CanvasSnapshot } from './whiteboard-client.js'

const canvasSnapshotSchema = z.object({
  id: z.string(),
  name: z.string(),
  scene: z.object({ elements: z.array(z.unknown()) }),
  updatedAt: z.string(),
})

export type LoadResult =
  | { kind: 'ok'; snapshot: CanvasSnapshot }
  | { kind: 'not-found' }
  | { kind: 'corrupted' }

export type DeleteResult =
  | { deleted: true }
  | { deleted: false; reason: 'pointer-mismatch' | 'not-found' }

export interface BrowserLocalStore {
  getDefaultCanvasId(): Promise<string | null>
  setDefaultCanvasId(id: string): Promise<void>
  load(id: string): Promise<LoadResult>
  save(snapshot: CanvasSnapshot): Promise<void>
  del(expectedId: string): Promise<DeleteResult>
  // Unconditional delete of a canvas record by id, independent of the default pointer.
  // Optional capability used for best-effort cleanup of records del() cannot reach
  // (it only removes the canvas the default pointer currently aims at).
  removeCanvas?(id: string): Promise<void>
  generateId(): string
}

export class MemoryStore implements BrowserLocalStore {
  private defaultId: string | null = null
  private canvases = new Map<string, CanvasSnapshot>()

  async getDefaultCanvasId(): Promise<string | null> {
    return this.defaultId
  }

  async setDefaultCanvasId(id: string): Promise<void> {
    this.defaultId = id
  }

  async load(id: string): Promise<LoadResult> {
    const snapshot = this.canvases.get(id)
    if (!snapshot) return { kind: 'not-found' }
    return { kind: 'ok', snapshot }
  }

  async save(snapshot: CanvasSnapshot): Promise<void> {
    this.canvases.set(snapshot.id, snapshot)
  }

  async del(expectedId: string): Promise<DeleteResult> {
    if (this.defaultId === null) return { deleted: false, reason: 'not-found' }
    if (this.defaultId !== expectedId) return { deleted: false, reason: 'pointer-mismatch' }
    this.canvases.delete(expectedId)
    this.defaultId = null
    return { deleted: true }
  }

  async removeCanvas(id: string): Promise<void> {
    this.canvases.delete(id)
  }

  generateId(): string {
    return crypto.randomUUID()
  }
}

const DB_NAME = 'whiteboard'
// Both stores (legacy JSON canvases and Loro CRDT loroCanvases) share the same
// IndexedDB database. Opening at v1 after a v2 upgrade causes a VersionError, so
// this opener must stay in sync with loro-store.ts which opens at DB_VERSION 2.
const DB_VERSION = 2

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta')
      if (!db.objectStoreNames.contains('canvases')) db.createObjectStore('canvases')
      if (!db.objectStoreNames.contains('loroCanvases')) db.createObjectStore('loroCanvases')
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export class IndexedDBStore implements BrowserLocalStore {
  async getDefaultCanvasId(): Promise<string | null> {
    const db = await openDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('meta', 'readonly')
      const req = tx.objectStore('meta').get('defaultCanvasId')
      req.onsuccess = () => resolve((req.result as string | undefined) ?? null)
      req.onerror = () => reject(req.error)
      tx.oncomplete = () => db.close()
    })
  }

  async setDefaultCanvasId(id: string): Promise<void> {
    const db = await openDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('meta', 'readwrite')
      tx.objectStore('meta').put(id, 'defaultCanvasId')
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onerror = () => reject(tx.error)
    })
  }

  async load(id: string): Promise<LoadResult> {
    const db = await openDb()
    return new Promise((resolve) => {
      const tx = db.transaction('canvases', 'readonly')
      const req = tx.objectStore('canvases').get(id)
      req.onsuccess = () => {
        if (req.result === undefined) { resolve({ kind: 'not-found' }); return }
        const parsed = canvasSnapshotSchema.safeParse(req.result)
        resolve(parsed.success ? { kind: 'ok', snapshot: parsed.data } : { kind: 'corrupted' })
      }
      req.onerror = () => resolve({ kind: 'corrupted' })
      tx.oncomplete = () => db.close()
    })
  }

  async save(snapshot: CanvasSnapshot): Promise<void> {
    const db = await openDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('canvases', 'readwrite')
      tx.objectStore('canvases').put(snapshot, snapshot.id)
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onerror = () => reject(tx.error)
    })
  }

  async del(expectedId: string): Promise<DeleteResult> {
    const db = await openDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['meta', 'canvases'], 'readwrite')
      const metaStore = tx.objectStore('meta')
      const canvasStore = tx.objectStore('canvases')
      let earlyResult: DeleteResult | null = null

      const getReq = metaStore.get('defaultCanvasId')
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
        metaStore.delete('defaultCanvasId')
        canvasStore.delete(expectedId)
      }
      tx.oncomplete = () => { db.close(); resolve({ deleted: true }) }
      tx.onabort = () => {
        db.close()
        // earlyResult is set only when our code calls tx.abort() (pointer-mismatch / not-found).
        // An abort without earlyResult is an unexpected engine failure — reject so callers can surface it.
        if (earlyResult !== null) resolve(earlyResult)
        else reject(tx.error ?? new DOMException('Transaction aborted unexpectedly', 'AbortError'))
      }
      tx.onerror = () => { db.close(); reject(tx.error) }
    })
  }

  async removeCanvas(id: string): Promise<void> {
    const db = await openDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('canvases', 'readwrite')
      tx.objectStore('canvases').delete(id)
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onerror = () => { db.close(); reject(tx.error) }
    })
  }

  generateId(): string {
    return crypto.randomUUID()
  }
}
