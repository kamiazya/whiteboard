import { describe, expect } from 'vitest'
import { snapshotChunkSchema, snapshotManifestSchema } from './snapshot.js'
import { chunkSnapshot, reassembleSnapshot } from './snapshot-helpers.js'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'

function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    const j = seed % (i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

describe('chunkSnapshot / reassembleSnapshot properties', () => {
  fcTest.prop([fc.uint8Array({ maxLength: 500 }), fc.integer({ min: 1, max: 64 })], withDefaults())(
    'round-trips arbitrary bytes through chunkSnapshot -> reassembleSnapshot',
    (bytes, maxChunkBytes) => {
      const { manifest, chunks } = chunkSnapshot(bytes, maxChunkBytes)
      expect(reassembleSnapshot(manifest, chunks)).toEqual(bytes)
    },
  )

  fcTest.prop(
    [
      fc.uint8Array({ minLength: 1, maxLength: 500 }),
      fc.integer({ min: 1, max: 64 }),
      fc.integer(),
    ],
    withDefaults(),
  )(
    'reassembly is order-independent for any permutation of a well-formed chunk set',
    (bytes, maxChunkBytes, seed) => {
      const { manifest, chunks } = chunkSnapshot(bytes, maxChunkBytes)
      const inOrder = reassembleSnapshot(manifest, chunks)
      const permuted = reassembleSnapshot(manifest, shuffle(chunks, seed))
      expect(permuted).toEqual(inOrder)
    },
  )

  fcTest.prop([fc.uint8Array({ maxLength: 500 }), fc.integer({ min: 1, max: 64 })], withDefaults())(
    'chunkSnapshot output always satisfies structural invariants and parses under its schemas',
    (bytes, maxChunkBytes) => {
      const { manifest, chunks } = chunkSnapshot(bytes, maxChunkBytes)

      expect(manifest.chunkCount).toBe(chunks.length)
      expect(manifest.chunkCount === 0).toBe(manifest.totalBytes === 0)
      const totalChunkBytes = chunks.reduce((sum, chunk) => sum + chunk.bytes.byteLength, 0)
      expect(totalChunkBytes).toBe(manifest.totalBytes)

      expect(() => snapshotManifestSchema.parse(manifest)).not.toThrow()
      for (const chunk of chunks) {
        expect(chunk.of).toBe(manifest.chunkCount)
        expect(chunk.bytes.byteLength).toBeGreaterThan(0)
        expect(chunk.bytes.byteLength).toBeLessThanOrEqual(maxChunkBytes)
        expect(() => snapshotChunkSchema.parse(chunk)).not.toThrow()
      }
    },
  )
})
