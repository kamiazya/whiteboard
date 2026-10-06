import type { BlobRef, BlobStore } from '@kamiazya/whiteboard-ports'
import { blobRefSchema } from '@kamiazya/whiteboard-ports'
import { z } from 'zod'
import { DOCUMENT_FILES_STORE, whiteboardDbName } from './browser-idb.js'
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
 * A v1 record nobody ever reads is never converted, and need not be: the
 * reference sweep (`browser-file-sweep.ts`) drops it once nothing names it.
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
 * Serialises a write of a reference against a sweep's delete, in every tab.
 *
 * Two ids can name one blob, and `put` writes the bytes before the mapping.
 * Unserialised, a sweep dropping the last OTHER mapping to those bytes sees
 * no reference to them in between, deletes them, and the mapping `put` then
 * writes names nothing. A Web Lock spans tabs, which a module-level promise
 * would not; where the API is absent (jsdom) the call runs unserialised.
 */
function withFilesLock<T>(dbName: string | undefined, run: () => Promise<T>): Promise<T> {
  const locks = globalThis.navigator?.locks
  if (locks === undefined) return run()
  return locks.request(`whiteboard:document-files:${dbName ?? whiteboardDbName()}`, run)
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

  put(fileId: string, entry: { mimeType: string; blob: Blob; created: number }): Promise<void> {
    return withFilesLock(this.dbName, () => this.putUnlocked(fileId, entry))
  }

  private async putUnlocked(
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
  delete(fileId: string): Promise<void> {
    return withFilesLock(this.dbName, () => this.deleteUnlocked(fileId))
  }

  /**
   * Drops every reference `keep` does not claim that was stored before
   * `createdBefore`, each through `delete`, and answers the ids dropped.
   *
   * The age is what covers an upload whose document has not been saved yet:
   * the image is stored first and the node naming it arrives with the next
   * save, so a fresh reference is unclaimed by construction. A record that
   * does not parse is left where it is — this store cannot say how old it is.
   */
  sweep(keep: (fileId: string) => boolean, createdBefore: number): Promise<string[]> {
    return withFilesLock(this.dbName, async () => {
      const candidates = await inTransaction(
        this.dbName,
        [DOCUMENT_FILES_STORE],
        'readonly',
        async (tx) => {
          const store = tx.objectStore(DOCUMENT_FILES_STORE)
          const keys = await request(store.getAllKeys())
          const rows = await request(store.getAll())
          return keys.flatMap((key, i) => {
            const parsed = documentFileRecordSchema.safeParse(rows[i])
            if (typeof key !== 'string' || !parsed.success) return []
            return parsed.data.created < createdBefore && !keep(key) ? [key] : []
          })
        },
      )
      for (const fileId of candidates) await this.deleteUnlocked(fileId)
      return candidates
    })
  }

  private async deleteUnlocked(fileId: string): Promise<void> {
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
