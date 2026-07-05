import { openWhiteboardDb } from './browser-idb.js'
import type { CanvasSnapshot } from './whiteboard-client.js'
import { canvasSnapshotSchema } from './whiteboard-client.js'

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
  listCanvases(): Promise<CanvasSnapshot[]>
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

  async listCanvases(): Promise<CanvasSnapshot[]> {
    return [...this.canvases.values()]
  }
}

export class IndexedDBStore implements BrowserLocalStore {
  async getDefaultCanvasId(): Promise<string | null> {
    const db = await openWhiteboardDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('meta', 'readonly')
      const req = tx.objectStore('meta').get('defaultCanvasId')
      req.onsuccess = () => resolve((req.result as string | undefined) ?? null)
      req.onerror = () => reject(req.error)
      tx.oncomplete = () => db.close()
    })
  }

  async setDefaultCanvasId(id: string): Promise<void> {
    const db = await openWhiteboardDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('meta', 'readwrite')
      tx.objectStore('meta').put(id, 'defaultCanvasId')
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
      const tx = db.transaction('canvases', 'readonly')
      const req = tx.objectStore('canvases').get(id)
      req.onsuccess = () => {
        if (req.result === undefined) {
          resolve({ kind: 'not-found' })
          return
        }
        const parsed = canvasSnapshotSchema.safeParse(req.result)
        resolve(parsed.success ? { kind: 'ok', snapshot: parsed.data } : { kind: 'corrupted' })
      }
      req.onerror = () => resolve({ kind: 'corrupted' })
      tx.oncomplete = () => db.close()
    })
  }

  async save(snapshot: CanvasSnapshot): Promise<void> {
    const db = await openWhiteboardDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('canvases', 'readwrite')
      tx.objectStore('canvases').put(snapshot, snapshot.id)
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

  async removeCanvas(id: string): Promise<void> {
    const db = await openWhiteboardDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('canvases', 'readwrite')
      tx.objectStore('canvases').delete(id)
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

  async listCanvases(): Promise<CanvasSnapshot[]> {
    const db = await openWhiteboardDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('canvases', 'readonly')
      const cursorReq = tx.objectStore('canvases').openCursor()
      const results: CanvasSnapshot[] = []
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result
        if (!cursor) return
        // Hydrate through the single parse boundary; skip a corrupt/legacy row
        // instead of throwing so it cannot blank the whole list.
        const parsed = canvasSnapshotSchema.safeParse(cursor.value)
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
