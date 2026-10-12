/**
 * Where a replica's cached images are FILED: the pointer from a replica's
 * workspace id to the blobs its images occupy. What the images are and how
 * they are sealed is `replica-images.ts`; this half needs no key, so a copy
 * can be deleted — images included — by a tab that cannot read it.
 *
 * The bytes live in the content-addressed `BlobStore` as SEALED envelopes,
 * never in `DocumentFileStore`. That is what keeps the browser's own file
 * sweep (`browser-file-sweep.ts`) and this cache from deleting each other's
 * bytes: the sweep deletes only blobs a `documentFiles` mapping names, and
 * an AES-GCM envelope under a fresh IV never hashes to the digest of any
 * picture a browser-kept document stores, the same image included.
 *
 * The pointer sits in localStorage beside the replica registry, for the
 * reasons `replica-wrapped-key-store.ts` gives: small, per origin, and no
 * `DB_VERSION` bump. Everything in it is opaque — the fileId index is a
 * sealed envelope and the rest are digests of ciphertext.
 */
import type { BlobRef, BlobStore } from '@kamiazya/whiteboard-ports'
import { blobRefSchema } from '@kamiazya/whiteboard-ports'
import { z } from 'zod'
import { IdbBlobStore } from './idb-blob-store.js'
import { safeGetItem, safeSetItem } from './safe-local-storage.js'
import {
  readStoredRecord,
  serializeStoredRecord,
  withoutStoredEntry,
  withStoredEntry,
} from './stored-record.js'

const STORE_KEY = 'whiteboard:replica-images'

const replicaImagePointerSchema = z
  .object({
    /** The fileId -> blob index, as base64 of a sealed envelope. */
    index: z.string(),
    /** Every blob this replica's images occupy. */
    blobs: z.array(blobRefSchema),
  })
  .strict()

export type ReplicaImagePointer = z.infer<typeof replicaImagePointerSchema>

function load() {
  return readStoredRecord(safeGetItem(STORE_KEY), replicaImagePointerSchema)
}

export function readReplicaImagePointer(workspaceId: string): ReplicaImagePointer | undefined {
  return load().entries[workspaceId]
}

/**
 * Writes the pointer and answers whether it stuck. A browser refusing the
 * write (a full quota) must not leave the caller believing blobs it just
 * stored are named by something.
 */
export function writeReplicaImagePointer(
  workspaceId: string,
  pointer: ReplicaImagePointer,
): boolean {
  const text = serializeStoredRecord(withStoredEntry(load(), workspaceId, pointer))
  safeSetItem(STORE_KEY, text)
  return safeGetItem(STORE_KEY) === text
}

/**
 * Serialises one replica's image writes across tabs: a pull and a delete, or
 * two pulls, interleaving would each delete what the other just filed.
 * Unserialised where the API is absent (jsdom).
 */
export function withReplicaImagesLock<T>(workspaceId: string, run: () => Promise<T>): Promise<T> {
  const locks = globalThis.navigator?.locks
  if (locks === undefined) return run()
  return locks.request(`whiteboard:replica-images:${workspaceId}`, run)
}

/** Deletes blobs, each on its own: one that fails leaves garbage, never a stopped cleanup. */
export async function deleteReplicaImageBlobs(
  refs: readonly BlobRef[],
  blobs: BlobStore,
): Promise<void> {
  for (const ref of refs) await blobs.delete({ ref }).catch(() => {})
}

/**
 * Drops a replica's images with its record. The pointer goes first: a failure
 * between the two leaves blobs nothing names, never a pointer to bytes that
 * are gone.
 */
export function dropReplicaImages(
  workspaceId: string,
  blobs: BlobStore = new IdbBlobStore(),
): Promise<void> {
  const record = load()
  if (!(workspaceId in record.entries) && !(workspaceId in record.unread)) return Promise.resolve()
  return withReplicaImagesLock(workspaceId, async () => {
    const current = load()
    safeSetItem(STORE_KEY, serializeStoredRecord(withoutStoredEntry(current, workspaceId)))
    const pointer = current.entries[workspaceId]
    if (pointer !== undefined) await deleteReplicaImageBlobs(pointer.blobs, blobs)
  })
}
