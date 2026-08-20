import { Loro } from 'loro-crdt'
import { openWhiteboardDb } from './browser-idb.js'
import { shouldCompact } from './loro-compaction.js'
import { type LoroRecordEnvelope, loroRecordEnvelopeSchema } from './loro-record-envelope.js'

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
 * Replay a record into one snapshot. Returns null when any byte refuses to
 * import — an unfoldable log is left exactly as it was, because losing edits
 * to save space is not a trade this is allowed to make.
 */
function foldDeltas(snapshot: Uint8Array, deltas: readonly Uint8Array[]): Uint8Array | null {
  try {
    const doc = new Loro()
    doc.import(snapshot)
    for (const delta of deltas) doc.import(delta)
    return doc.export({ mode: 'snapshot' })
  } catch {
    return null
  }
}

/**
 * LoroStore: persists Loro CRDT snapshot+delta records in the 'loroDocuments'
 * IndexedDB object store. Isolated from the 'documents' JSON metadata store
 * so legacy records are never misread as Loro bytes.
 *
 * load() deep-validates bytes by importing them into a throwaway LoroDoc so
 * structurally-valid envelopes carrying invalid CRDT bytes are caught here
 * rather than surfacing as throws inside the hook's onSnapshot/onRemoteUpdate.
 */
export class LoroStore {
  /**
   * Which database to talk to. Production never passes it; a browser test
   * does, so its fixtures cannot collide with another test FILE's — they
   * share an origin, and therefore one `whiteboard` database.
   */
  constructor(private readonly dbName?: string) {}

  /**
   * Bytes for a brand-new, empty Loro document snapshot. Callers that only
   * need to seed a fresh canvas (e.g. the page-layer create-canvas flow) use
   * this instead of importing `loro-crdt` themselves, keeping CRDT-library
   * knowledge (the `{ mode: 'snapshot' }` export API) confined to this file.
   */
  createEmptySnapshot(): Uint8Array {
    return new Loro().export({ mode: 'snapshot' })
  }

  async load(documentId: string): Promise<LoroLoadResult> {
    const db = await openWhiteboardDb(this.dbName)
    return new Promise((resolve) => {
      const tx = db.transaction('loroDocuments', 'readonly')
      const req = tx.objectStore('loroDocuments').get(documentId)
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

  async save(documentId: string, snapshot: Uint8Array): Promise<void> {
    const db = await openWhiteboardDb(this.dbName)
    return new Promise((resolve, reject) => {
      const envelope: LoroRecordEnvelope = {
        v: 1,
        snapshot,
        updatedAt: new Date().toISOString(),
      }
      const tx = db.transaction('loroDocuments', 'readwrite')
      tx.objectStore('loroDocuments').put(envelope, documentId)
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
  async appendDelta(documentId: string, delta: Uint8Array): Promise<void> {
    const db = await openWhiteboardDb(this.dbName)
    return new Promise((resolve, reject) => {
      const tx = db.transaction('loroDocuments', 'readwrite')
      const store = tx.objectStore('loroDocuments')
      const getReq = store.get(documentId)
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
        const deltas = [...(parsed.data.deltas ?? []), delta]
        // Folding HERE rather than on read: this is already the one
        // read-modify-write transaction over this record, so the fold cannot
        // race an append, and a fresh open never pays for a log someone
        // else's session grew. Measured at the budget, the fold costs about
        // 10ms of synchronous replay and it happens once per 64KB written.
        const folded = shouldCompact(deltas) ? foldDeltas(parsed.data.snapshot, deltas) : null
        const updated: LoroRecordEnvelope =
          folded === null
            ? { ...parsed.data, deltas, updatedAt: new Date().toISOString() }
            : { v: 1, snapshot: folded, updatedAt: new Date().toISOString() }
        store.put(updated, documentId)
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
