/**
 * The images a replica's documents draw, cached with the replica so its page
 * can draw them with the daemon away.
 *
 * Pulled with the record (`cacheDaemonWorkspace`, which both the Settings
 * move and the background refresh run): every image the record names is read
 * through the same daemon file route the online page reads, sealed under the
 * record's own key (`replicaRecordKey`), and filed by
 * `replica-image-store.ts`. A pull that no longer names an image drops it.
 *
 * Bounded by `REPLICA_IMAGE_BUDGET_BYTES` per replica. An image past the
 * budget, or one the daemon did not serve, is simply not cached, and the page
 * labels it unavailable offline rather than drawing its raw id. Images
 * already cached are kept ahead of new ones, so a replica at its budget does
 * not trade one picture for another on every pull.
 *
 * Each image is sealed with its own fileId in the AAD, so an envelope moved
 * under another id fails to open; the index is sealed too, so not even which
 * ids are cached is readable without the key.
 */
import { openBytes, sealBytes } from '@kamiazya/whiteboard-daemon-client/read-plane'
import {
  collectImageRefIds,
  documentContainers,
  readWorkspaceDocuments,
} from '@kamiazya/whiteboard-loro-adapter'
import { base64ToBytes, bytesToBase64 } from '@kamiazya/whiteboard-model'
import type { BlobRef, BlobStore } from '@kamiazya/whiteboard-ports'
import { blobRefSchema, docRefKey } from '@kamiazya/whiteboard-ports'
import type { LoroDoc } from 'loro-crdt'
import { z } from 'zod'
import { readDaemonImage } from './daemon-image-read.js'
import { IdbBlobStore } from './idb-blob-store.js'
import {
  deleteReplicaImageBlobs,
  readReplicaImagePointer,
  withReplicaImagesLock,
  writeReplicaImagePointer,
} from './replica-image-store.js'
import { replicaRecordKey } from './replica-store.js'
import { decodeEnvelope, encodeEnvelope } from './sealed-document-store.js'

/** Four images at the daemon's per-file ceiling (`MAX_FILE_UPLOAD_BYTES`). */
const REPLICA_IMAGE_BUDGET_BYTES = 64 * 1024 * 1024

const replicaImageIndexSchema = z.record(
  z.string(),
  z.object({ ref: blobRefSchema, mimeType: z.string(), bytes: z.number().int() }).strict(),
)

type ReplicaImageIndex = z.infer<typeof replicaImageIndexSchema>
type SealingKey = NonNullable<Awaited<ReturnType<typeof replicaRecordKey>>>

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

/** The AAD names: the record's own key, then what beside it this envelope is. */
const indexContext = (workspaceId: string): string =>
  `${docRefKey({ kind: 'workspace-tree', workspaceId })}#images`
const imageContext = (workspaceId: string, fileId: string): string =>
  `${docRefKey({ kind: 'workspace-tree', workspaceId })}#image:${fileId}`

async function seal(
  key: SealingKey,
  bytes: Uint8Array,
  docKey: string,
): Promise<Uint8Array<ArrayBuffer>> {
  return encodeEnvelope(
    await sealBytes(key.key, new Uint8Array(bytes), { docKey, epoch: key.epoch }),
  )
}

async function open(key: SealingKey, sealed: Uint8Array, docKey: string): Promise<Uint8Array> {
  const envelope = decodeEnvelope(sealed)
  return openBytes(key.key, envelope, { docKey, epoch: envelope.epoch })
}

/** The cached index, or an empty one when there is none or it will not open under this key. */
async function readIndex(workspaceId: string, key: SealingKey): Promise<ReplicaImageIndex> {
  const pointer = readReplicaImagePointer(workspaceId)
  if (pointer === undefined) return {}
  const sealed = base64ToBytes(pointer.index)
  if (sealed === null) return {}
  try {
    const plain = await open(key, sealed, indexContext(workspaceId))
    return replicaImageIndexSchema.parse(JSON.parse(textDecoder.decode(plain)))
  } catch {
    return {}
  }
}

/** Every image the record names, each with the path of a document that names it — the file route's address. */
function namedImages(record: LoroDoc): Map<string, string> {
  const named = new Map<string, string>()
  for (const entry of readWorkspaceDocuments(record)) {
    for (const fileId of collectImageRefIds(documentContainers(record, entry.documentId))) {
      if (!named.has(fileId)) named.set(fileId, entry.path)
    }
  }
  return named
}

export interface CacheReplicaImagesOptions {
  fetch: typeof globalThis.fetch
  daemonBaseUrl: string
  workspaceId: string
  /** The replica's record as just saved. */
  record: LoroDoc
  budgetBytes?: number
  /** Production: the browser's own `IdbBlobStore`. */
  blobs?: BlobStore
}

/**
 * One image off the daemon's file route, or null for anything but a served
 * file. Best-effort by design: a picture this pass could not fetch is simply
 * not cached yet, and the next pull's pass asks again.
 */
async function fetchImage(
  options: CacheReplicaImagesOptions,
  fileId: string,
  path: string,
): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
  try {
    const blob = await readDaemonImage(
      options.fetch,
      options.daemonBaseUrl,
      options.workspaceId,
      path,
      fileId,
    )
    if (blob === undefined) return null
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mimeType: blob.type }
  } catch {
    return null
  }
}

/** The next index: what is cached and still named first, then what fits of the rest. */
async function nextIndex(
  options: CacheReplicaImagesOptions,
  key: SealingKey,
  blobs: BlobStore,
): Promise<ReplicaImageIndex> {
  const named = namedImages(options.record)
  const previous = await readIndex(options.workspaceId, key)
  const budget = options.budgetBytes ?? REPLICA_IMAGE_BUDGET_BYTES
  const next: ReplicaImageIndex = {}
  let total = 0
  for (const fileId of named.keys()) {
    const kept = previous[fileId]
    if (kept === undefined || total + kept.bytes > budget) continue
    if (!(await blobs.has({ ref: kept.ref })).exists) continue
    next[fileId] = kept
    total += kept.bytes
  }
  for (const [fileId, path] of named) {
    if (next[fileId] !== undefined) continue
    const fetched = await fetchImage(options, fileId, path)
    if (fetched === null || total + fetched.bytes.byteLength > budget) continue
    const sealed = await seal(key, fetched.bytes, imageContext(options.workspaceId, fileId))
    const { ref } = await blobs.put({ bytes: sealed })
    next[fileId] = { ref, mimeType: fetched.mimeType, bytes: fetched.bytes.byteLength }
    total += fetched.bytes.byteLength
  }
  return next
}

const refKey = (ref: BlobRef): string => ref.digestHex

/**
 * Brings a replica's image cache in line with its record. Answers how many
 * images are cached; throws only on a storage failure, which the caller
 * reports — a single image the daemon would not serve is not one.
 */
export function cacheReplicaImages(options: CacheReplicaImagesOptions): Promise<number> {
  const blobs = options.blobs ?? new IdbBlobStore()
  return withReplicaImagesLock(options.workspaceId, async () => {
    const key = await replicaRecordKey(options.workspaceId)
    if (key === null) return 0
    const pointer = readReplicaImagePointer(options.workspaceId)
    const index = await nextIndex(options, key, blobs)
    const entries = Object.values(index)
    if (entries.length === 0 && pointer === undefined) return 0
    const indexText = textEncoder.encode(JSON.stringify(index))
    const sealedIndex = await seal(key, indexText, indexContext(options.workspaceId))
    const filed = writeReplicaImagePointer(options.workspaceId, {
      index: bytesToBase64(sealedIndex),
      blobs: entries.map((entry) => entry.ref),
    })
    // Whichever pointer stands keeps its blobs; the other side's are garbage.
    const previous = pointer?.blobs ?? []
    const current = entries.map((entry) => entry.ref)
    const [standing, superseded] = filed ? [current, previous] : [previous, current]
    const keep = new Set(standing.map(refKey))
    await deleteReplicaImageBlobs(
      superseded.filter((ref) => !keep.has(refKey(ref))),
      blobs,
    )
    return filed ? entries.length : 0
  })
}

/**
 * The cached images among `fileIds`, opened. An id the cache does not hold,
 * or whose bytes will not open, is absent from the answer; so is everything
 * while the record's key is not held.
 */
export async function loadReplicaImages(
  workspaceId: string,
  fileIds: readonly string[],
  blobs: BlobStore = new IdbBlobStore(),
): Promise<Map<string, Blob>> {
  const out = new Map<string, Blob>()
  const key = await replicaRecordKey(workspaceId)
  if (key === null) return out
  const index = await readIndex(workspaceId, key)
  for (const fileId of fileIds) {
    const entry = index[fileId]
    if (entry === undefined) continue
    try {
      const stored = await blobs.get({ ref: entry.ref })
      if (stored === null) continue
      const bytes = await open(key, stored.bytes, imageContext(workspaceId, fileId))
      out.set(fileId, new Blob([bytes as BlobPart], { type: entry.mimeType }))
    } catch {
      // A damaged envelope costs that one picture, never the page.
    }
  }
  return out
}
