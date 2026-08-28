/**
 * `BlobStore` over IndexedDB — the browser's twin of the daemon's
 * `FsBlobStore`, held to the same conformance suite.
 *
 * Three things the filesystem store has to do that this one does not, and
 * they are the reason this file is short rather than a port of that one:
 *
 * - **No sharding.** `FsBlobStore` splits the digest into
 *   `<first2>/<remaining62>` because a directory holding a million entries is
 *   a filesystem problem. An IndexedDB object store is a B-tree; the whole
 *   ref is one key.
 * - **No base64 envelope.** IndexedDB stores a `Uint8Array` through the
 *   structured clone algorithm, so the bytes stay bytes. Base64 on disk costs
 *   33% size and a decode on every read.
 * - **No JSON parse boundary.** Nothing here can be malformed the way a
 *   hand-written file can, so there is no `CorruptStoredDataError` twin — a
 *   record either round-trips or was never written.
 *
 * What it does have that the Node one does not: the digest is ASYNC.
 * `crypto.subtle.digest` returns a promise where `node:crypto`'s
 * `createHash` is synchronous. `put` already returns a promise, so this
 * changes nothing a caller can see.
 */

import type {
  BlobDeleteInput,
  BlobGetInput,
  BlobGetResult,
  BlobHasInput,
  BlobHasResult,
  BlobPutInput,
  BlobPutResult,
  BlobRef,
  BlobStore,
} from '@kamiazya/whiteboard-ports'
import { z } from 'zod'
import { BLOBS_STORE } from './browser-idb.js'
import { inTransaction, request } from './idb-tx.js'

/**
 * Realm-independent, unlike `z.instanceof(Uint8Array)`: structured clone can
 * hand back a Uint8Array minted in another realm (jsdom's fake-indexeddb
 * does), and instanceof then rejects a perfectly stored record — the same
 * class-identity family as ports' isWorkspaceNotFoundError. The toString tag
 * names the type but IS spoofable by a plain object carrying
 * `Symbol.toStringTag`, so `ArrayBuffer.isView` — which reads the internal
 * typed-array slot and also holds across realms — is what proves the value
 * is a genuine view rather than an object wearing the name.
 */
export function isStoredUint8Array(value: unknown): value is Uint8Array {
  return (
    value instanceof Uint8Array ||
    (ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint8Array]')
  )
}

const uint8ArraySchema = z.custom<Uint8Array>(isStoredUint8Array)

/**
 * A stored blob. `v` is the envelope version: a record written by a future
 * shape reads as a MISS rather than a crash, matching how every other store
 * in this app treats an envelope it does not recognise.
 *
 * `contentType` is absent rather than null when unset — the port's
 * `BlobGetResult` marks it optional, and IndexedDB drops `undefined`
 * properties on write, so the stored shape and the port's shape agree without
 * a conversion on either side.
 */
const blobRecordSchema = z
  .object({
    v: z.literal(1),
    bytes: uint8ArraySchema,
    contentType: z.string().min(1).optional(),
  })
  .strict()

type BlobRecord = z.infer<typeof blobRecordSchema>

/**
 * The primary key. Includes the algorithm, so introducing a second one later
 * cannot collide with a sha-256 digest that happens to share its hex.
 */
function refKey(ref: BlobRef): string {
  return `${ref.algorithm}:${ref.digestHex}`
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // See the conformance suite: a copy rather than a cast, because a
  // `Uint8Array<ArrayBufferLike>` is not a `BufferSource` since TS 5.7.
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export class IdbBlobStore implements BlobStore {
  /** Only tests pass this; see `openWhiteboardDb`'s note on why it exists. */
  constructor(private readonly dbName?: string) {}

  async put(input: BlobPutInput): Promise<BlobPutResult> {
    const ref: BlobRef = { algorithm: 'sha-256', digestHex: await sha256Hex(input.bytes) }
    // A copy, because the caller keeps their array and may write to it next.
    // For a CONTENT-addressed store that is not merely a stale read: the
    // bytes would no longer hash to the ref they are filed under.
    const record: BlobRecord = {
      v: 1,
      bytes: new Uint8Array(input.bytes),
      ...(input.contentType === undefined ? {} : { contentType: input.contentType }),
    }
    await inTransaction(this.dbName, [BLOBS_STORE], 'readwrite', async (tx) => {
      // `put`, not `add`: storing the same bytes twice is the deduplicating
      // case, not a conflict. It overwrites with an identical payload except
      // for `contentType`, where the last writer wins — the bytes are what
      // the ref promises, and the type is a hint about them.
      await request(tx.objectStore(BLOBS_STORE).put(record, refKey(ref)))
    })
    return { ref }
  }

  async get(input: BlobGetInput): Promise<BlobGetResult> {
    return inTransaction(this.dbName, [BLOBS_STORE], 'readonly', async (tx) => {
      const raw = await request(tx.objectStore(BLOBS_STORE).get(refKey(input.ref)))
      if (raw === undefined) return null
      const parsed = blobRecordSchema.safeParse(raw)
      if (!parsed.success) return null
      return {
        // Copied on the way out for the same reason as on the way in: the
        // caller owns what they receive, and structured clone already gave
        // us a private array, so this guards only against a future read path
        // that does not.
        bytes: new Uint8Array(parsed.data.bytes),
        ...(parsed.data.contentType === undefined ? {} : { contentType: parsed.data.contentType }),
      }
    })
  }

  async has(input: BlobHasInput): Promise<BlobHasResult> {
    return inTransaction(this.dbName, [BLOBS_STORE], 'readonly', async (tx) => {
      const key = await request(tx.objectStore(BLOBS_STORE).getKey(refKey(input.ref)))
      return { exists: key !== undefined }
    })
  }

  async delete(input: BlobDeleteInput): Promise<void> {
    await inTransaction(this.dbName, [BLOBS_STORE], 'readwrite', async (tx) => {
      // IndexedDB's delete is already total on a key that is not there, which
      // is what the port asks for — a caller holding a stale ref is ordinary.
      await request(tx.objectStore(BLOBS_STORE).delete(refKey(input.ref)))
    })
  }
}
