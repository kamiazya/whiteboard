import { z } from 'zod'
import { openWhiteboardDb } from './browser-idb.js'

/**
 * Versioned envelope for image file records persisted in the 'documentFiles'
 * IndexedDB object store. Single parse boundary — every IDB read for
 * canvasFiles goes through this. Type is derived via z.infer; no parallel
 * hand-written interface (mirrors loro-store.ts's loroRecordEnvelopeSchema).
 *
 * v: envelope format version (literal 1). Bump this when the envelope shape
 *    changes in a backward-incompatible way; old/unknown-version records are
 *    treated as a cache miss (get() resolves null) rather than crashing.
 */
export const documentFileRecordSchema = z.object({
  v: z.literal(1),
  mimeType: z.string(),
  created: z.number(),
  blob: z.instanceof(Blob),
})

type DocumentFileRecord = z.infer<typeof documentFileRecordSchema>

/**
 * Decode a data: URL into a Blob. Prefers the MIME type embedded in the
 * dataURL prefix (the authoritative source for what was actually encoded)
 * and falls back to `fallbackMimeType` only when the prefix itself is
 * missing/malformed.
 *
 * Throws on a structurally invalid dataURL (no comma separator) or invalid
 * base64 payload — callers must not swallow this into a silently-empty Blob.
 */
export function dataUrlToBlob(dataURL: string, fallbackMimeType: string): Blob {
  const commaIndex = dataURL.indexOf(',')
  if (commaIndex === -1) {
    throw new Error('dataUrlToBlob: malformed dataURL (no comma separator)')
  }
  const header = dataURL.slice(0, commaIndex)
  const base64 = dataURL.slice(commaIndex + 1)

  const prefixMatch = /^data:([^;,]+)/.exec(header)
  const mimeType = prefixMatch?.[1] ?? fallbackMimeType

  let binary: string
  try {
    binary = atob(base64)
  } catch {
    throw new Error('dataUrlToBlob: invalid base64 payload')
  }

  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new Blob([bytes], { type: mimeType })
}

/**
 * DocumentFileStore: persists uploaded image Blobs in the 'documentFiles'
 * IndexedDB object store, keyed by the caller-supplied fileId. Isolated from
 * 'loroDocuments'/'documents' so a schema issue in one store never corrupts
 * reads of the others.
 *
 * Keying is global (not scoped per-canvas): Excalidraw fileIds are
 * content-hashes, so cross-canvas reuse of the same fileId is an acceptable,
 * intentional trade-off. Records are never deleted here, so the store grows
 * unbounded — GC / refcounting is a deliberate follow-up, not an oversight.
 */
export class DocumentFileStore {
  async put(
    fileId: string,
    entry: { mimeType: string; blob: Blob; created: number },
  ): Promise<void> {
    const db = await openWhiteboardDb()
    return new Promise((resolve, reject) => {
      const record: DocumentFileRecord = {
        v: 1,
        mimeType: entry.mimeType,
        created: entry.created,
        blob: entry.blob,
      }
      // transaction() throws synchronously when the store is missing — e.g.
      // the v3->v4 upgrade was blocked by a stale tab — so the connection
      // must be closed here too, not only in the async lifecycle callbacks.
      let tx: IDBTransaction
      try {
        tx = db.transaction('documentFiles', 'readwrite')
      } catch (err) {
        db.close()
        reject(err)
        return
      }
      tx.objectStore('documentFiles').put(record, fileId)
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
   * Returns the stored Blob for fileId, or null for an unknown id, a
   * corrupt/unknown-version record, AND a failure to open the database
   * (VersionError, denied access, etc). Never throws — a damaged record or an
   * unreachable store degrades to a missing image rather than crashing the
   * read path.
   */
  async get(fileId: string): Promise<Blob | null> {
    let db: IDBDatabase
    try {
      db = await openWhiteboardDb()
    } catch {
      return null
    }
    return new Promise((resolve) => {
      // Same synchronous-throw hazard as put(): a missing store must close
      // the connection and degrade to null, per this method's never-throws
      // contract.
      let tx: IDBTransaction
      try {
        tx = db.transaction('documentFiles', 'readonly')
      } catch {
        db.close()
        resolve(null)
        return
      }
      const req = tx.objectStore('documentFiles').get(fileId)
      req.onsuccess = () => {
        if (req.result === undefined) {
          resolve(null)
          return
        }
        const parsed = documentFileRecordSchema.safeParse(req.result)
        resolve(parsed.success ? parsed.data.blob : null)
      }
      req.onerror = (e) => {
        e.preventDefault()
        db.close()
        resolve(null)
      }
      tx.onerror = () => {
        db.close()
        resolve(null)
      }
      tx.onabort = () => {
        db.close()
        resolve(null)
      }
      tx.oncomplete = () => db.close()
    })
  }
}
