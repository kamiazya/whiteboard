import { Loro } from 'loro-crdt'
import { z } from 'zod'
import { openWhiteboardDb } from './browser-idb.js'

/**
 * Versioned envelope for Loro records persisted in IndexedDB.
 * Single parse boundary — every IDB read for loroCanvases goes through this.
 * Type is derived via z.infer; no parallel hand-written interface.
 *
 * v: envelope format version (literal 1). Bump this when the envelope shape
 *    changes in a backward-incompatible way; old records will be rejected as
 *    'corrupt-snapshot' and the caller is responsible for recovery.
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
  | { kind: 'corrupt-snapshot' }
  | { kind: 'corrupt-delta' }
  | { kind: 'unsupported-version' }

/**
 * Try importing bytes into a throwaway LoroDoc to confirm they are valid Loro
 * bytes (snapshot or update). Returns false if the import throws.
 */
function isValidLoroBytes(bytes: Uint8Array): boolean {
  try {
    const probe = new Loro()
    probe.import(bytes)
    return true
  } catch {
    return false
  }
}

/**
 * LoroStore: persists Loro CRDT snapshot+delta records in the 'loroCanvases'
 * IndexedDB object store. Isolated from the 'canvases' JSON metadata store
 * so legacy records are never misread as Loro bytes.
 *
 * load() deep-validates bytes by importing them into a throwaway LoroDoc so
 * structurally-valid envelopes carrying invalid CRDT bytes are caught here
 * rather than surfacing as throws inside the hook's onSnapshot/onRemoteUpdate.
 */
export class LoroStore {
  async load(canvasId: string): Promise<LoroLoadResult> {
    const db = await openWhiteboardDb()
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
          // Zod envelope parse failed — envelope version unknown or structurally wrong.
          // Distinguish a version mismatch (v field present but not 1) from a fully
          // mangled record so callers can surface the right error to the user.
          const raw = req.result as Record<string, unknown>
          if (typeof raw.v === 'number' && raw.v !== 1) {
            resolve({ kind: 'unsupported-version' })
          } else {
            resolve({ kind: 'corrupt-snapshot' })
          }
          return
        }

        // Deep-validate snapshot bytes by importing into a throwaway LoroDoc.
        if (!isValidLoroBytes(parsed.data.snapshot)) {
          resolve({ kind: 'corrupt-snapshot' })
          return
        }

        // Deep-validate each delta in order; report the first bad one.
        for (const delta of parsed.data.deltas ?? []) {
          if (!isValidLoroBytes(delta)) {
            resolve({ kind: 'corrupt-delta' })
            return
          }
        }

        resolve({
          kind: 'ok',
          snapshot: parsed.data.snapshot,
          deltas: parsed.data.deltas,
        })
      }
      // req.onerror fires when the get request itself fails; close db and resolve
      // so the IDB connection is not leaked. Prevent the error from propagating to tx.onerror.
      req.onerror = (e) => {
        e.preventDefault()
        db.close()
        resolve({ kind: 'corrupt-snapshot' })
      }
      // tx.onerror/tx.onabort fire when the transaction errors before req completes
      // (e.g. quota exceeded, database closing mid-read). Without these the promise
      // never settles and loadAndDeliver stalls permanently.
      tx.onerror = () => {
        db.close()
        resolve({ kind: 'corrupt-snapshot' })
      }
      tx.onabort = () => {
        db.close()
        resolve({ kind: 'corrupt-snapshot' })
      }
      tx.oncomplete = () => db.close()
    })
  }

  async save(canvasId: string, snapshot: Uint8Array): Promise<void> {
    const db = await openWhiteboardDb()
    return new Promise((resolve, reject) => {
      const envelope: LoroRecordEnvelope = {
        v: 1,
        snapshot,
        updatedAt: new Date().toISOString(),
      }
      const tx = db.transaction('loroCanvases', 'readwrite')
      tx.objectStore('loroCanvases').put(envelope, canvasId)
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

  /**
   * Append an incremental Loro update to the delta log for a canvas.
   * The entire read-modify-write runs inside a single readwrite transaction so
   * concurrent calls cannot interleave: IDB serializes transactions on the same
   * store, which prevents the TOCTOU window where two concurrent callers both
   * read 'not-found' and the second clobbers the first.
   * If no record exists yet, this is a no-op (snapshot must be saved first).
   */
  async appendDelta(canvasId: string, delta: Uint8Array): Promise<void> {
    const db = await openWhiteboardDb()
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
      tx.oncomplete = () => {
        db.close()
        resolve()
      }
      tx.onerror = () => {
        db.close()
        reject(tx.error)
      }
      // tx.onabort fires when our code calls tx.abort() (corrupt envelope branch above).
      tx.onabort = () => {
        db.close()
        reject(new DOMException('Corrupt envelope; delta not appended', 'AbortError'))
      }
    })
  }
}
