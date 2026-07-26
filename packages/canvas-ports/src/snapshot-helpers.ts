import type { SnapshotChunk, SnapshotManifest } from './snapshot.js'
import { SnapshotReassemblyError } from './snapshot-reassembly-error.js'

/**
 * Splits `bytes` into a sequence of chunks no larger than `maxChunkBytes`.
 * `maxChunkBytes` is a caller-supplied positive safe integer — this shared
 * package never hardcodes an implementation-specific cap (e.g. the
 * Cloudflare Durable Objects ~2MB message limit). Empty input always
 * produces zero chunks, never a zero-byte chunk, so the empty-snapshot
 * manifest stays distinguishable from an invalid chunk list.
 */
export function chunkSnapshot(
  bytes: Uint8Array,
  maxChunkBytes: number,
): { manifest: SnapshotManifest; chunks: SnapshotChunk[] } {
  if (!Number.isSafeInteger(maxChunkBytes) || maxChunkBytes <= 0) {
    throw new RangeError('maxChunkBytes must be a positive safe integer')
  }

  const totalBytes = bytes.byteLength
  if (totalBytes === 0) {
    return { manifest: { chunkCount: 0, totalBytes: 0, maxChunkBytes }, chunks: [] }
  }

  const chunkCount = Math.ceil(totalBytes / maxChunkBytes)
  const chunks: SnapshotChunk[] = []
  for (let index = 0; index < chunkCount; index++) {
    const start = index * maxChunkBytes
    const end = Math.min(start + maxChunkBytes, totalBytes)
    chunks.push({ index, of: chunkCount, bytes: bytes.slice(start, end) })
  }

  return { manifest: { chunkCount, totalBytes, maxChunkBytes }, chunks }
}

/**
 * Reconstructs the original bytes from a manifest and its chunks.
 * Order-independent: chunks are sorted by `index` before validation, so a
 * well-formed set delivered out of order succeeds — out-of-order is never a
 * corruption. Every other deviation from "exactly one chunk per index in
 * [0, chunkCount), each sized per `maxChunkBytes`, summing to `totalBytes`"
 * throws a typed `SnapshotReassemblyError`.
 */
export function reassembleSnapshot(
  manifest: SnapshotManifest,
  chunks: readonly SnapshotChunk[],
): Uint8Array {
  const { chunkCount, totalBytes, maxChunkBytes } = manifest

  if (chunkCount === 0) {
    if (chunks.length > 0) {
      throw new SnapshotReassemblyError(
        'INVALID_MANIFEST',
        `manifest declares chunkCount 0 but received ${chunks.length} chunk(s)`,
      )
    }
    return new Uint8Array(0)
  }

  if (chunks.length === 0) {
    throw new SnapshotReassemblyError(
      'EMPTY_CHUNK_LIST',
      `expected ${chunkCount} chunks, received none`,
    )
  }

  const seenIndices = new Set<number>()
  for (const chunk of chunks) {
    if (chunk.index >= chunkCount) {
      throw new SnapshotReassemblyError(
        'EXTRA_CHUNK',
        `chunk index ${chunk.index} is out of range for chunkCount ${chunkCount}`,
      )
    }
    if (seenIndices.has(chunk.index)) {
      throw new SnapshotReassemblyError(
        'DUPLICATE_INDEX',
        `chunk index ${chunk.index} appears more than once`,
      )
    }
    seenIndices.add(chunk.index)
  }

  for (let index = 0; index < chunkCount; index++) {
    if (!seenIndices.has(index)) {
      throw new SnapshotReassemblyError('MISSING_CHUNK', `chunk index ${index} is missing`)
    }
  }

  const sorted = [...chunks].sort((a, b) => a.index - b.index)

  for (const chunk of sorted) {
    if (chunk.of !== chunkCount) {
      throw new SnapshotReassemblyError(
        'WRONG_OF',
        `chunk ${chunk.index} declares of=${chunk.of}, expected ${chunkCount}`,
      )
    }
  }

  const lastIndex = chunkCount - 1
  for (const chunk of sorted) {
    const length = chunk.bytes.byteLength
    // Every chunk but the last must be exactly maxChunkBytes; the last holds
    // the remainder, so any non-empty length up to maxChunkBytes is valid.
    const isValidLength =
      chunk.index === lastIndex ? length > 0 && length <= maxChunkBytes : length === maxChunkBytes
    if (!isValidLength) {
      throw new SnapshotReassemblyError(
        'WRONG_BYTE_LENGTH',
        `chunk ${chunk.index} has byte length ${length}, which does not fit maxChunkBytes ${maxChunkBytes}`,
      )
    }
  }

  // Sum the (already length-validated) chunks and compare against
  // manifest.totalBytes before allocating/writing into the destination
  // buffer. Deferring this check until after `combined.set(...)` would let
  // an inconsistent manifest (chunks summing to more than totalBytes) throw
  // a raw, untyped RangeError instead of the promised SnapshotReassemblyError.
  const aggregateLength = sorted.reduce((sum, chunk) => sum + chunk.bytes.byteLength, 0)
  if (aggregateLength !== totalBytes) {
    throw new SnapshotReassemblyError(
      'WRONG_TOTAL_LENGTH',
      `reassembled ${aggregateLength} bytes, expected totalBytes ${totalBytes}`,
    )
  }

  const combined = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of sorted) {
    combined.set(chunk.bytes, offset)
    offset += chunk.bytes.byteLength
  }

  return combined
}
