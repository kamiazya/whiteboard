import type { BlobRef, BlobStore } from '@kamiazya/whiteboard-ports'
import { blobRefSchema } from '@kamiazya/whiteboard-ports'
import { z } from 'zod'
import { DOCUMENT_FILES_STORE } from './browser-idb.js'
import { IdbBlobStore } from './idb-blob-store.js'
import { inTransaction, request } from './idb-tx.js'

/**
 * Versioned envelope for the records in the `documentFiles` IndexedDB object
 * store. Single parse boundary — every read goes through this.
 *
 * There are two shapes because there were two designs:
 *
 * - **v1** held the `Blob` itself, keyed by the caller's fileId. Identical
 *   bytes under two ids were two copies, and nothing could be deleted, so the
 *   store grew without bound.
 * - **v2** holds a `BlobRef` instead. The bytes live in the content-addressed
 *   `BlobStore`, so two ids naming the same image share one copy, and a
 *   reference can be dropped.
 *
 * v1 is still READ, and a v1 record read through `get` is rewritten as v2 on
 * the spot — the bytes are already in hand, and `BlobStore.put` is idempotent,
 * so the migration costs one write the first time an old image is displayed.
 *
 * ponytail: a v1 record nobody ever reads is never converted. That is
 * acceptable because it is exactly the record a reference-sweeping GC would
 * collect anyway; if a sweep is ever written, it converts the remainder.
 *
 * An unknown/newer version is a cache miss (`get` resolves null) rather than a
 * crash.
 */
export const documentFileRecordSchema = z.union([
  z.object({
    v: z.literal(1),
    mimeType: z.string(),
    created: z.number(),
    blob: z.instanceof(Blob),
  }),
  z.object({
    v: z.literal(2),
    mimeType: z.string(),
    created: z.number(),
    ref: blobRefSchema,
  }),
])

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
 * The document's file references: a fileId -> `BlobRef` mapping over the
 * content-addressed `BlobStore`.
 *
 * The fileId stays the address a document embeds, because it IS one: the
 * string `newImageRef` builds is written into the document, and the daemon's
 * file route validates it. Moving documents to content addresses is a change
 * to a published shape and is not this layer's to make — so the bytes moved
 * and the address did not, and this class is what sits between them.
 *
 * What that buys, both of which the previous store could not have:
 *
 * - the same image referenced from two documents is stored once
 * - a reference can be DROPPED, and the bytes go with it once no other
 *   reference names them
 *
 * Keying is global rather than per-document, unchanged from before: fileIds
 * are unique per upload, and sharing one across documents is the deduplicating
 * case rather than a collision.
 */
export class DocumentFileStore {
  constructor(
    private readonly blobs: BlobStore = new IdbBlobStore(),
    private readonly dbName?: string,
  ) {}

  async put(
    fileId: string,
    entry: { mimeType: string; blob: Blob; created: number },
  ): Promise<void> {
    const bytes = new Uint8Array(await entry.blob.arrayBuffer())
    // The bytes first. A mapping written before its blob would, if the write
    // after it failed, name bytes that are not there — a broken image with a
    // record claiming otherwise. The other order leaves an unreferenced blob,
    // which reads as nothing at all and is what the sweep collects.
    const { ref } = await this.blobs.put({ bytes, contentType: entry.mimeType })
    const record: DocumentFileRecord = {
      v: 2,
      mimeType: entry.mimeType,
      created: entry.created,
      ref,
    }
    await inTransaction(this.dbName, [DOCUMENT_FILES_STORE], 'readwrite', async (tx) => {
      await request(tx.objectStore(DOCUMENT_FILES_STORE).put(record, fileId))
    })
  }

  /**
   * The stored image for `fileId`, or null for an unknown id, a corrupt or
   * unknown-version record, a reference whose bytes are gone, AND a failure to
   * open the database. Never throws — a damaged record or an unreachable
   * store degrades to a missing image rather than taking the read path with
   * it.
   */
  async get(fileId: string): Promise<Blob | null> {
    let record: DocumentFileRecord | null
    try {
      record = await inTransaction(this.dbName, [DOCUMENT_FILES_STORE], 'readonly', async (tx) => {
        const raw = await request(tx.objectStore(DOCUMENT_FILES_STORE).get(fileId))
        if (raw === undefined) return null
        const parsed = documentFileRecordSchema.safeParse(raw)
        return parsed.success ? parsed.data : null
      })
    } catch {
      return null
    }
    if (record === null) return null

    if (record.v === 1) {
      // Read-through migration: the bytes are in hand, so convert rather than
      // leave a record that can never be deduplicated or deleted. A failure
      // here must not cost the caller their image, so the conversion is
      // best-effort and the original blob is returned either way.
      void this.put(fileId, {
        mimeType: record.mimeType,
        blob: record.blob,
        created: record.created,
      }).catch(() => {})
      return record.blob
    }

    try {
      const stored = await this.blobs.get({ ref: record.ref })
      if (stored === null) return null
      return new Blob([stored.bytes as BlobPart], { type: record.mimeType })
    } catch {
      return null
    }
  }

  /**
   * Drops the reference, and the bytes with it when this was the last one.
   *
   * ponytail: the "last one" check is a scan of every reference. A browser
   * holds tens of these, not millions, and the alternative — a stored
   * refcount — is a second piece of state that can disagree with the mapping
   * it counts. Revisit if a real corpus makes the scan visible.
   */
  async delete(fileId: string): Promise<void> {
    const removed = await inTransaction(
      this.dbName,
      [DOCUMENT_FILES_STORE],
      'readwrite',
      async (tx) => {
        const store = tx.objectStore(DOCUMENT_FILES_STORE)
        const raw = await request(store.get(fileId))
        if (raw === undefined) return null
        await request(store.delete(fileId))
        const parsed = documentFileRecordSchema.safeParse(raw)
        if (!parsed.success || parsed.data.v !== 2) return null
        const ref: BlobRef = parsed.data.ref
        // Inside the same transaction as the delete, so a concurrent write
        // cannot add a reference between the removal and the count.
        const rest = await request(store.getAll())
        const stillReferenced = rest.some((row: unknown) => {
          const other = documentFileRecordSchema.safeParse(row)
          return other.success && other.data.v === 2 && other.data.ref.digestHex === ref.digestHex
        })
        return stillReferenced ? null : ref
      },
    )
    if (removed !== null) await this.blobs.delete({ ref: removed })
  }
}
