import { z } from 'zod'

/**
 * Versioned envelope for Loro records persisted in IndexedDB.
 * Single parse boundary — every IDB read for loroCanvases goes through this.
 * Type is derived via z.infer; no parallel hand-written interface.
 *
 * v: envelope format version (literal 1). Bump this when the envelope shape
 *    changes in a backward-incompatible way; old records will be rejected as
 *    'corrupted' and the caller is responsible for recovery.
 */
// z.custom pins the inferred type to Uint8Array<ArrayBuffer> (matching lib:ES2020+DOM),
// which is narrower than the z.instanceof(Uint8Array) result (Uint8Array<ArrayBufferLike>).
const uint8ArraySchema = z.custom<Uint8Array>((v) => v instanceof Uint8Array)

export const loroRecordEnvelopeSchema = z.object({
  v: z.literal(1),
  snapshot: uint8ArraySchema,
  updatedAt: z.string(),
  deltas: z.array(uint8ArraySchema).optional(),
})

export type LoroRecordEnvelope = z.infer<typeof loroRecordEnvelopeSchema>

export type LoroLoadResult =
  | { kind: 'ok'; snapshot: Uint8Array; deltas?: Uint8Array[] }
  | { kind: 'not-found' }
  | { kind: 'corrupted' }

const DB_NAME = 'whiteboard'
/**
 * DB_VERSION 2 adds the 'loroCanvases' object store for Loro CRDT records.
 * The v1 'canvases' and 'meta' stores are preserved untouched by the upgrade.
 */
const DB_VERSION = 2

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result
      // Preserve v1 stores; only add the new Loro store.
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta')
      if (!db.objectStoreNames.contains('canvases')) db.createObjectStore('canvases')
      if (!db.objectStoreNames.contains('loroCanvases')) db.createObjectStore('loroCanvases')
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/**
 * LoroStore: persists Loro CRDT snapshot+delta records in the 'loroCanvases'
 * IndexedDB object store (DB v2). Isolated from the v1 'canvases' JSON store
 * so legacy records are never misread as Loro bytes.
 */
export class LoroStore {
  async load(canvasId: string): Promise<LoroLoadResult> {
    const db = await openDb()
    return new Promise((resolve) => {
      const tx = db.transaction('loroCanvases', 'readonly')
      const req = tx.objectStore('loroCanvases').get(canvasId)
      req.onsuccess = () => {
        if (req.result === undefined) {
          resolve({ kind: 'not-found' })
          return
        }
        const parsed = loroRecordEnvelopeSchema.safeParse(req.result)
        if (!parsed.success) {
          resolve({ kind: 'corrupted' })
          return
        }
        resolve({
          kind: 'ok',
          snapshot: parsed.data.snapshot,
          deltas: parsed.data.deltas,
        })
      }
      // req.onerror fires when the get request itself fails; close db and resolve as corrupted
      // so the IDB connection is not leaked. Prevent the error from propagating to tx.onerror.
      req.onerror = (e) => { e.preventDefault(); db.close(); resolve({ kind: 'corrupted' }) }
      // tx.onerror/tx.onabort fire when the transaction errors before req completes
      // (e.g. quota exceeded, database closing mid-read). Without these the promise
      // never settles and loadAndDeliver stalls permanently.
      tx.onerror = () => { db.close(); resolve({ kind: 'corrupted' }) }
      tx.onabort = () => { db.close(); resolve({ kind: 'corrupted' }) }
      tx.oncomplete = () => db.close()
    })
  }

  async save(canvasId: string, snapshot: Uint8Array): Promise<void> {
    const db = await openDb()
    return new Promise((resolve, reject) => {
      const envelope: LoroRecordEnvelope = {
        v: 1,
        snapshot,
        updatedAt: new Date().toISOString(),
      }
      const tx = db.transaction('loroCanvases', 'readwrite')
      tx.objectStore('loroCanvases').put(envelope, canvasId)
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onerror = () => { db.close(); reject(tx.error) }
    })
  }

  /**
   * Append an incremental Loro update to the delta log for a canvas.
   * Reads the current record, appends the delta, and writes back atomically.
   * If no record exists yet, this is a no-op (snapshot must be saved first).
   */
  async appendDelta(canvasId: string, delta: Uint8Array): Promise<void> {
    const db = await openDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('loroCanvases', 'readwrite')
      const store = tx.objectStore('loroCanvases')
      const getReq = store.get(canvasId)
      getReq.onsuccess = () => {
        const raw = getReq.result
        if (raw === undefined) {
          // No snapshot saved yet; skip delta (caller must save snapshot first).
          return
        }
        const parsed = loroRecordEnvelopeSchema.safeParse(raw)
        if (!parsed.success) {
          // Corrupt envelope: abort the transaction so the promise rejects and
          // the caller (BrowserLocalBackend) can route to onError('storage-failure').
          tx.abort()
          return
        }
        const updated: LoroRecordEnvelope = {
          ...parsed.data,
          deltas: [...(parsed.data.deltas ?? []), delta],
          updatedAt: new Date().toISOString(),
        }
        store.put(updated, canvasId)
      }
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onerror = () => { db.close(); reject(tx.error) }
      // tx.onabort fires when our code calls tx.abort() (corrupt envelope branch above).
      tx.onabort = () => { db.close(); reject(new DOMException('Corrupt envelope; delta not appended', 'AbortError')) }
    })
  }
}
