/**
 * `DocumentStore` decorator that keeps a daemon-kept workspace's replica as
 * ciphertext at rest (ADR-0042 decision 2, over S1's `sealBytes`/`openBytes`
 * primitive in `@kamiazya/whiteboard-daemon-client/read-plane`).
 *
 * The inner store (production: `IdbDocumentStore`) never learns this exists —
 * it stores whatever bytes it is handed, and its own chunk/manifest
 * bookkeeping is unaware they are envelopes. Sealing therefore happens PER
 * CHUNK and per delta, not once over the whole snapshot: the inner store's
 * `saveSnapshot` stores the chunk list as given and its `loadSnapshot`
 * cross-checks the manifest against the ACTUAL stored bytes
 * (`idb-document-store.ts`'s manifest/chunk agreement check), so the sealed
 * manifest handed down here must describe the sealed bytes exactly. Sealing
 * once and re-chunking on read would also fail the port's own conformance
 * suite, which pins byte-identical chunk layout.
 *
 * The frontier (Loro version-vector metadata, read by `readFrontier` and
 * carried on every save/load) is NOT content and stays plaintext throughout —
 * comparing frontiers is how a caller decides whether it is caught up, and
 * nothing in this store's contract needs that comparison to see cleartext.
 *
 * This module names no `*_STORE` constant and calls no schema `.parse` on a
 * persisted record, so `idb-stored-shapes-surface.test.ts`'s scan does not
 * treat it as a stored-shape module — the inner store's own record schema is
 * unaffected; from its point of view these are opaque bytes.
 */

import type { SealedEnvelope } from '@kamiazya/whiteboard-daemon-client/read-plane'
import {
  openBytes,
  sealBytes,
  sealedEnvelopeSchema,
} from '@kamiazya/whiteboard-daemon-client/read-plane'
import type {
  AppendDeltasInput,
  AppendDeltasResult,
  DeleteDocInput,
  DocumentStore,
  LoadDeltasInput,
  LoadDeltasResult,
  LoadSnapshotInput,
  LoadSnapshotResult,
  ReadFrontierInput,
  ReadFrontierResult,
  ReadSnapshotManifestInput,
  ReadSnapshotManifestResult,
  SaveCompactedSnapshotInput,
  SaveCompactedSnapshotResult,
  SaveSnapshotInput,
  SnapshotChunk,
  SnapshotManifest,
} from '@kamiazya/whiteboard-ports'
import { docRefKey, StoredDocumentUnreadableError } from '@kamiazya/whiteboard-ports'

/**
 * What S4's in-memory session-key holder answers for one document.
 * `'plaintext'` is `replica-store.ts`'s routing answer for a ref this build
 * never seals — a browser-kept workspace, or any `document:*` ref — so the
 * ONE factory can hand every construction the same decorator instead of
 * branching between a sealed and a bare `DocumentStore`.
 */
export interface ReplicaKeyProvider {
  keyFor(documentId: string): Promise<{ key: CryptoKey; epoch: number } | 'withheld' | 'plaintext'>
}

/**
 * A record is present but this build has no key to read it — the reader
 * should reconnect, not re-sync. Kept distinct from
 * `StoredDocumentUnreadableError` ("your build cannot read this"): that one
 * means the bytes are damaged, this one means they are fine and the key is
 * temporarily gone.
 */
export class ReplicaKeyWithheldError extends Error {
  constructor(readonly documentId: string) {
    super(`replica key for document ${documentId} is withheld`)
    this.name = 'ReplicaKeyWithheldError'
  }
}

const ENVELOPE_VERSION = 0x01
const AES_GCM_IV_BYTES = 12
const ENVELOPE_HEADER_BYTES = 1 + 4 + AES_GCM_IV_BYTES // version + epoch + iv
const GCM_TAG_BYTES = 16

/** Fixed per-envelope cost: `[0x01 version][epoch u32 BE][iv 12][ct...]`. */
export const ENVELOPE_OVERHEAD = ENVELOPE_HEADER_BYTES + GCM_TAG_BYTES

/**
 * A compact, deterministic binary layout for `SealedEnvelope` — NOT JSON.
 * The inner store's byte-length accounting (its manifest/chunk agreement
 * check) wants an exact, predictable size, and this is what makes the
 * manifest arithmetic below (`+ ENVELOPE_OVERHEAD` per chunk) exact.
 */
export function encodeEnvelope(envelope: SealedEnvelope): Uint8Array<ArrayBuffer> {
  // `epochSchema` only requires a nonnegative integer; `DataView.setUint32`
  // does not throw on a value outside u32 range, it silently wraps via
  // ToUint32. An unchecked overflow here would encode a different epoch than
  // the one `sealBytes` used for the AAD, and the mismatch would surface at
  // decode as an opaque AEAD failure rather than as the overflow it was.
  if (envelope.epoch > 0xffffffff) {
    throw new RangeError(`sealed envelope epoch ${envelope.epoch} exceeds the u32 field width`)
  }
  const out = new Uint8Array(ENVELOPE_HEADER_BYTES + envelope.ct.byteLength)
  out[0] = ENVELOPE_VERSION
  new DataView(out.buffer).setUint32(1, envelope.epoch, false)
  out.set(envelope.iv, 5)
  out.set(envelope.ct, ENVELOPE_HEADER_BYTES)
  return out
}

/** Inverts `encodeEnvelope`. Throws on a version byte it does not know or a buffer too short to hold a real envelope. */
export function decodeEnvelope(bytes: Uint8Array): SealedEnvelope {
  if (bytes.byteLength < ENVELOPE_HEADER_BYTES + GCM_TAG_BYTES) {
    throw new Error(
      `sealed envelope must be at least ${ENVELOPE_HEADER_BYTES + GCM_TAG_BYTES} bytes, got ${bytes.byteLength}`,
    )
  }
  if (bytes[0] !== ENVELOPE_VERSION) {
    throw new Error(`sealed envelope has unsupported version byte ${bytes[0]}`)
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const epoch = view.getUint32(1, false)
  const iv = bytes.slice(5, ENVELOPE_HEADER_BYTES)
  const ct = bytes.slice(ENVELOPE_HEADER_BYTES)
  return sealedEnvelopeSchema.parse({ v: 1, iv, ct, epoch })
}

function sealManifest(manifest: SnapshotManifest): SnapshotManifest {
  return {
    chunkCount: manifest.chunkCount,
    totalBytes: manifest.totalBytes + ENVELOPE_OVERHEAD * manifest.chunkCount,
    maxChunkBytes: manifest.maxChunkBytes + ENVELOPE_OVERHEAD,
  }
}

function openManifest(manifest: SnapshotManifest, documentId: string): SnapshotManifest {
  const overhead = ENVELOPE_OVERHEAD * manifest.chunkCount
  const totalBytes = manifest.totalBytes - overhead
  // Re-check the port's own `(chunkCount === 0) === (totalBytes === 0)` invariant
  // (`snapshotManifestSchema`'s `.refine`) after subtracting overhead: a sealed
  // chunk's plaintext is always >= 1 byte, so a real sealed manifest with
  // chunkCount > 0 always has totalBytes strictly greater than its own overhead.
  // A `totalBytes < overhead` check alone misses the exact-equality boundary and
  // would let a corrupted manifest through as a schema-invalid plaintext one.
  const malformed =
    totalBytes < 0 ||
    manifest.maxChunkBytes <= ENVELOPE_OVERHEAD ||
    (manifest.chunkCount === 0) !== (totalBytes === 0)
  if (malformed) {
    throw new StoredDocumentUnreadableError(
      'malformed',
      `sealed manifest for document ${documentId} is smaller than its own envelope overhead`,
    )
  }
  return {
    chunkCount: manifest.chunkCount,
    totalBytes,
    maxChunkBytes: manifest.maxChunkBytes - ENVELOPE_OVERHEAD,
  }
}

/** The provider's answer once withholding has been turned into a throw. */
type ResolvedKey = { key: CryptoKey; epoch: number } | 'plaintext'

export class SealedDocumentStore implements DocumentStore {
  constructor(
    private readonly inner: DocumentStore,
    private readonly keys: ReplicaKeyProvider,
  ) {}

  /**
   * Asked every time, never cached in a field: the whole point of routing a
   * key through a provider is that S4 may answer differently call to call
   * (a fresh epoch, or a session that has since locked; 'plaintext' never
   * changes for a given ref, but asking costs nothing extra to route on).
   */
  async #resolveKey(documentId: string): Promise<ResolvedKey> {
    const resolved = await this.keys.keyFor(documentId)
    if (resolved === 'withheld') throw new ReplicaKeyWithheldError(documentId)
    return resolved
  }

  async #seal(
    resolved: ResolvedKey,
    documentId: string,
    plaintext: Uint8Array,
  ): Promise<Uint8Array<ArrayBuffer>> {
    if (resolved === 'plaintext') return new Uint8Array(plaintext) as Uint8Array<ArrayBuffer>
    // A private copy: `sealBytes` wants the buffer-backed narrowing WebCrypto requires.
    const envelope = await sealBytes(resolved.key, new Uint8Array(plaintext), {
      documentId,
      epoch: resolved.epoch,
    })
    return encodeEnvelope(envelope)
  }

  /**
   * Opens sealed bytes under `resolved`. The envelope's OWN epoch is what
   * feeds the AAD context — not whatever epoch the key was derived for — so
   * a bumped epoch refuses old ciphertext by GCM tag mismatch rather than by
   * an explicit equality check: the key and the envelope's embedded epoch
   * disagreeing is exactly what a stale session's key looks like.
   */
  async #open(
    resolved: ResolvedKey,
    documentId: string,
    sealed: Uint8Array,
    what: string,
  ): Promise<Uint8Array<ArrayBuffer>> {
    if (resolved === 'plaintext') return new Uint8Array(sealed) as Uint8Array<ArrayBuffer>
    let envelope: SealedEnvelope
    try {
      envelope = decodeEnvelope(sealed)
    } catch (cause) {
      throw new StoredDocumentUnreadableError(
        'malformed',
        `${what} of document ${documentId} does not decode as a sealed envelope: ${String(cause)}`,
      )
    }
    try {
      return await openBytes(resolved.key, envelope, { documentId, epoch: envelope.epoch })
    } catch (cause) {
      throw new StoredDocumentUnreadableError(
        'malformed',
        `${what} of document ${documentId} failed to open under its sealed key: ${String(cause)}`,
      )
    }
  }

  /**
   * Resolves the key once per batch and not at all for an empty one — an
   * empty batch must succeed even while the key is withheld.
   */
  async #withKey<T, R>(
    documentId: string,
    items: readonly T[],
    fn: (resolved: ResolvedKey, item: T) => Promise<R>,
  ): Promise<R[]> {
    if (items.length === 0) return []
    const resolved = await this.#resolveKey(documentId)
    return Promise.all(items.map((item) => fn(resolved, item)))
  }

  async #sealChunks(
    documentId: string,
    manifest: SnapshotManifest,
    chunks: readonly SnapshotChunk[],
  ): Promise<{ manifest: SnapshotManifest; chunks: SnapshotChunk[] }> {
    // Never resolved for an empty batch, matching #withKey: a snapshot with
    // no chunks must save even while the key is withheld, and the manifest
    // for one is arm-independent (chunkCount 0 <=> totalBytes 0 either way).
    if (chunks.length === 0) return { manifest, chunks: [] }
    const resolved = await this.#resolveKey(documentId)
    const sealed = await Promise.all(
      chunks.map(async (chunk) => ({
        ...chunk,
        bytes: await this.#seal(resolved, documentId, chunk.bytes),
      })),
    )
    // Plaintext never carries the envelope overhead: applying sealManifest
    // here would give a browser-kept workspace a manifest byte-DIFFERENT
    // from what a bare IdbDocumentStore would have written for the same
    // input, breaking the plaintext-transparency property this arm exists
    // to hold.
    return {
      manifest: resolved === 'plaintext' ? manifest : sealManifest(manifest),
      chunks: sealed,
    }
  }

  /**
   * The manifest half of a read. Mirrors `#sealChunks`'s own gate exactly —
   * a manifest at chunkCount 0 was never transformed on the way in (empty
   * batches skip the key for every arm, see `#sealChunks`), so it must not
   * be transformed on the way out either, and the key is not even asked: an
   * empty manifest hides nothing, so a withheld or unreachable session still
   * answers instead of refusing metadata about a document with no bytes.
   * Otherwise the key is resolved (S4a memoises, so a replica pays one
   * mint) to decide whether `openManifest`'s arithmetic applies.
   */
  async #openManifestArm(
    documentId: string,
    manifest: SnapshotManifest,
  ): Promise<SnapshotManifest> {
    if (manifest.chunkCount === 0) return manifest
    const resolved = await this.#resolveKey(documentId)
    return resolved === 'plaintext' ? manifest : openManifest(manifest, documentId)
  }

  async saveSnapshot(input: SaveSnapshotInput): Promise<void> {
    const documentId = docRefKey(input.docRef)
    const sealed = await this.#sealChunks(documentId, input.manifest, input.chunks)
    await this.inner.saveSnapshot({ ...input, manifest: sealed.manifest, chunks: sealed.chunks })
  }

  async saveCompactedSnapshot(
    input: SaveCompactedSnapshotInput,
  ): Promise<SaveCompactedSnapshotResult> {
    const documentId = docRefKey(input.docRef)
    const sealed = await this.#sealChunks(documentId, input.manifest, input.chunks)
    return this.inner.saveCompactedSnapshot({
      ...input,
      manifest: sealed.manifest,
      chunks: sealed.chunks,
    })
  }

  async loadSnapshot(input: LoadSnapshotInput): Promise<LoadSnapshotResult> {
    const result = await this.inner.loadSnapshot(input)
    if (result === null) return null
    const documentId = docRefKey(input.docRef)
    const manifest = await this.#openManifestArm(documentId, result.manifest)
    const chunks = await this.#withKey(documentId, result.chunks, async (resolved, chunk) => ({
      ...chunk,
      bytes: await this.#open(resolved, documentId, chunk.bytes, `chunk ${chunk.index}`),
    }))
    return { ...result, manifest, chunks }
  }

  /**
   * Arithmetic only for a sealed or plaintext manifest — no chunk read,
   * matching the inner store's own promise that this answers without
   * touching chunk bytes.
   */
  async readSnapshotManifest(
    input: ReadSnapshotManifestInput,
  ): Promise<ReadSnapshotManifestResult> {
    const result = await this.inner.readSnapshotManifest(input)
    if (result === null) return null
    return {
      ...result,
      manifest: await this.#openManifestArm(docRefKey(input.docRef), result.manifest),
    }
  }

  async appendDeltas(input: AppendDeltasInput): Promise<AppendDeltasResult> {
    const documentId = docRefKey(input.docRef)
    const updates = await this.#withKey(documentId, input.deltaBatch.updates, (resolved, u) =>
      this.#seal(resolved, documentId, u),
    )
    return this.inner.appendDeltas({ ...input, deltaBatch: { ...input.deltaBatch, updates } })
  }

  async loadDeltas(input: LoadDeltasInput): Promise<LoadDeltasResult> {
    const documentId = docRefKey(input.docRef)
    const result = await this.inner.loadDeltas(input)
    const updates = await this.#withKey(documentId, result.updates, (resolved, u) =>
      this.#open(resolved, documentId, u, 'a delta'),
    )
    return { ...result, updates }
  }

  /** Loro version-vector metadata, not content — plaintext on both sides. */
  async readFrontier(input: ReadFrontierInput): Promise<ReadFrontierResult> {
    return this.inner.readFrontier(input)
  }

  async deleteDoc(input: DeleteDocInput): Promise<void> {
    return this.inner.deleteDoc(input)
  }
}
