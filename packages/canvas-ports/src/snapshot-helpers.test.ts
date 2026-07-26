import { describe, expect, it } from 'vitest'
import { snapshotChunkSchema, snapshotManifestSchema } from './snapshot.js'
import { chunkSnapshot, reassembleSnapshot } from './snapshot-helpers.js'
import { SnapshotReassemblyError } from './snapshot-reassembly-error.js'

function bytesOf(length: number): Uint8Array {
  const out = new Uint8Array(length)
  for (let i = 0; i < length; i++) out[i] = i % 256
  return out
}

describe('chunkSnapshot', () => {
  it('produces zero chunks for empty input', () => {
    const { manifest, chunks } = chunkSnapshot(new Uint8Array(), 4)
    expect(manifest).toEqual({ chunkCount: 0, totalBytes: 0, maxChunkBytes: 4 })
    expect(chunks).toEqual([])
  })

  it('produces a single chunk when bytes fit under maxChunkBytes', () => {
    const bytes = bytesOf(3)
    const { manifest, chunks } = chunkSnapshot(bytes, 4)
    expect(manifest).toEqual({ chunkCount: 1, totalBytes: 3, maxChunkBytes: 4 })
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toEqual({ index: 0, of: 1, bytes })
  })

  it('produces exactly k full chunks when bytes === k * maxChunkBytes', () => {
    const bytes = bytesOf(8)
    const { manifest, chunks } = chunkSnapshot(bytes, 4)
    expect(manifest.chunkCount).toBe(2)
    expect(chunks.map((c) => c.bytes.byteLength)).toEqual([4, 4])
  })

  it('makes the last chunk smaller when bytes does not divide evenly', () => {
    const bytes = bytesOf(9)
    const { chunks } = chunkSnapshot(bytes, 4)
    expect(chunks.map((c) => c.bytes.byteLength)).toEqual([4, 4, 1])
  })

  it('throws RangeError for a non-positive, non-integer, or non-safe-integer maxChunkBytes', () => {
    expect(() => chunkSnapshot(new Uint8Array(1), 0)).toThrow(RangeError)
    expect(() => chunkSnapshot(new Uint8Array(1), -1)).toThrow(RangeError)
    expect(() => chunkSnapshot(new Uint8Array(1), 1.5)).toThrow(RangeError)
    expect(() => chunkSnapshot(new Uint8Array(1), Number.MAX_SAFE_INTEGER + 2)).toThrow(RangeError)
  })

  it('helper output always parses under the schema (never emits a zero-byte chunk)', () => {
    const { manifest, chunks } = chunkSnapshot(bytesOf(5), 2)
    expect(snapshotManifestSchema.parse(manifest)).toEqual(manifest)
    for (const chunk of chunks) {
      expect(snapshotChunkSchema.parse(chunk)).toEqual(chunk)
    }
  })
})

describe('reassembleSnapshot', () => {
  it('round-trips a multi-chunk snapshot', () => {
    const bytes = bytesOf(9)
    const { manifest, chunks } = chunkSnapshot(bytes, 4)
    expect(reassembleSnapshot(manifest, chunks)).toEqual(bytes)
  })

  it('round-trips a single-chunk snapshot', () => {
    const bytes = bytesOf(3)
    const { manifest, chunks } = chunkSnapshot(bytes, 10)
    expect(reassembleSnapshot(manifest, chunks)).toEqual(bytes)
  })

  it('round-trips the empty snapshot', () => {
    const { manifest, chunks } = chunkSnapshot(new Uint8Array(), 4)
    expect(reassembleSnapshot(manifest, chunks)).toEqual(new Uint8Array())
  })

  it('succeeds on a shuffled (out-of-order) well-formed chunk set, matching the in-order result', () => {
    const bytes = bytesOf(9)
    const { manifest, chunks } = chunkSnapshot(bytes, 4)
    const shuffled = [chunks[2], chunks[0], chunks[1]]
    expect(reassembleSnapshot(manifest, shuffled)).toEqual(reassembleSnapshot(manifest, chunks))
  })

  it('throws SnapshotReassemblyError(MISSING_CHUNK) when a chunk is missing', () => {
    const { manifest, chunks } = chunkSnapshot(bytesOf(9), 4)
    try {
      reassembleSnapshot(manifest, [chunks[0], chunks[2]])
      expect.fail('expected reassembleSnapshot to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(SnapshotReassemblyError)
      expect((error as SnapshotReassemblyError).code).toBe('MISSING_CHUNK')
    }
  })

  it('throws SnapshotReassemblyError(EXTRA_CHUNK) when a chunk index is >= chunkCount', () => {
    const { manifest, chunks } = chunkSnapshot(bytesOf(9), 4)
    const extra = { index: 3, of: 3, bytes: new Uint8Array([1]) }
    try {
      reassembleSnapshot(manifest, [...chunks, extra])
      expect.fail('expected reassembleSnapshot to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(SnapshotReassemblyError)
      expect((error as SnapshotReassemblyError).code).toBe('EXTRA_CHUNK')
    }
  })

  it('throws SnapshotReassemblyError(DUPLICATE_INDEX) when an index repeats', () => {
    const { manifest, chunks } = chunkSnapshot(bytesOf(9), 4)
    try {
      reassembleSnapshot(manifest, [chunks[0], chunks[0], chunks[1]])
      expect.fail('expected reassembleSnapshot to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(SnapshotReassemblyError)
      expect((error as SnapshotReassemblyError).code).toBe('DUPLICATE_INDEX')
    }
  })

  it('throws SnapshotReassemblyError(WRONG_OF) when a chunk.of disagrees with manifest.chunkCount', () => {
    const { manifest, chunks } = chunkSnapshot(bytesOf(9), 4)
    const wrongOf = [{ ...chunks[0], of: 99 }, chunks[1], chunks[2]]
    try {
      reassembleSnapshot(manifest, wrongOf)
      expect.fail('expected reassembleSnapshot to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(SnapshotReassemblyError)
      expect((error as SnapshotReassemblyError).code).toBe('WRONG_OF')
    }
  })

  it('throws SnapshotReassemblyError(WRONG_BYTE_LENGTH) for a mid-sequence chunk shorter than maxChunkBytes', () => {
    const { manifest, chunks } = chunkSnapshot(bytesOf(9), 4)
    const truncated = [{ ...chunks[0], bytes: chunks[0].bytes.slice(0, 2) }, chunks[1], chunks[2]]
    try {
      reassembleSnapshot(manifest, truncated)
      expect.fail('expected reassembleSnapshot to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(SnapshotReassemblyError)
      expect((error as SnapshotReassemblyError).code).toBe('WRONG_BYTE_LENGTH')
    }
  })

  it('throws SnapshotReassemblyError(WRONG_TOTAL_LENGTH) when a fully well-formed chunk set disagrees with a mismatched manifest.totalBytes', () => {
    const { manifest, chunks } = chunkSnapshot(bytesOf(8), 4)
    const mismatchedManifest = { ...manifest, totalBytes: 99 }
    try {
      reassembleSnapshot(mismatchedManifest, chunks)
      expect.fail('expected reassembleSnapshot to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(SnapshotReassemblyError)
      expect((error as SnapshotReassemblyError).code).toBe('WRONG_TOTAL_LENGTH')
    }
  })

  it('throws SnapshotReassemblyError(EMPTY_CHUNK_LIST) when chunkCount > 0 but chunks is empty', () => {
    const manifest = { chunkCount: 2, totalBytes: 8, maxChunkBytes: 4 }
    try {
      reassembleSnapshot(manifest, [])
      expect.fail('expected reassembleSnapshot to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(SnapshotReassemblyError)
      expect((error as SnapshotReassemblyError).code).toBe('EMPTY_CHUNK_LIST')
    }
  })
})
