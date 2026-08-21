import { describe, expect, it } from 'vitest'
import type { DocRef, DocumentStore, SnapshotChunk } from '../index.js'

/**
 * The `DocumentStore` guarantees a TypeScript signature cannot carry, as
 * tests every implementation has to pass.
 *
 * These were spread across three files before — the in-memory double's suite,
 * the libSQL store's suite, and a parity property comparing the two. That
 * arrangement answers "do these two agree?" but not "what is the contract?",
 * so a third implementation had nothing to be held to. This is that.
 *
 * Two of the guarantees below look like bugs until you know why they are
 * there, and both are load-bearing:
 *
 * - **`loadSnapshot` reports the CURRENT frontier**, not the one the snapshot
 *   was saved with. A snapshot plus later deltas is a document whose frontier
 *   has moved on; answering with the stale one would tell a caller it is
 *   caught up when it is not.
 * - **`loadDeltas` ignores `sinceFrontier`** and returns the whole log.
 *   Comparing frontiers needs the loro-crdt runtime, which a store does not
 *   have — `Frontier` is an opaque `Uint8Array` at this layer. Returning
 *   everything is a superset of the correct answer for every caller, so a
 *   store that later learns to filter stays compatible.
 */
export function describeDocumentStoreConformance(
  makeStore: () => Promise<{ store: DocumentStore; dispose: () => Promise<void> }>,
): void {
  async function withStore(body: (store: DocumentStore) => Promise<void>): Promise<void> {
    const { store, dispose } = await makeStore()
    try {
      await body(store)
    } finally {
      await dispose()
    }
  }

  const DOC: DocRef = { kind: 'document', documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }
  const OTHER: DocRef = { kind: 'document', documentId: '01BX5ZZKBKACTAV9WEVGEMMVRZ' }
  // Same id STRING as a workspace would use, different kind. The key a store
  // derives has to keep these apart.
  const TREE: DocRef = { kind: 'workspace-tree', workspaceId: 'local' }

  // Annotated with the buffer parameter so this compiles the same way under
  // every consumer's lib: a bare `Uint8Array` is `Uint8Array<ArrayBufferLike>`
  // where DOM types are present, which is wider than the port's DTOs.
  const bytes = (...values: number[]): Uint8Array<ArrayBuffer> => new Uint8Array(values)

  function chunked(
    parts: Uint8Array<ArrayBuffer>[],
    maxChunkBytes = 4,
  ): {
    manifest: { chunkCount: number; totalBytes: number; maxChunkBytes: number }
    chunks: SnapshotChunk[]
  } {
    return {
      manifest: {
        chunkCount: parts.length,
        totalBytes: parts.reduce((sum, part) => sum + part.byteLength, 0),
        maxChunkBytes,
      },
      chunks: parts.map((part, index) => ({ index, of: parts.length, bytes: part })),
    }
  }

  const EMPTY = { manifest: { chunkCount: 0, totalBytes: 0, maxChunkBytes: 4 }, chunks: [] }

  describe('DocumentStore conformance', () => {
    it('answers null before anything has been saved', async () => {
      await withStore(async (store) => {
        expect(await store.loadSnapshot({ docRef: DOC })).toBeNull()
        expect(await store.readFrontier({ docRef: DOC })).toBeNull()
      })
    })

    it('answers an empty delta log for a document it has never seen', async () => {
      await withStore(async (store) => {
        const result = await store.loadDeltas({ docRef: DOC, sinceFrontier: bytes() })
        expect(result.updates).toEqual([])
        expect([...result.frontier]).toEqual([])
      })
    })

    it('round-trips a multi-chunk snapshot byte-identically', async () => {
      await withStore(async (store) => {
        const payload = chunked([bytes(1, 2, 3, 4), bytes(5, 6), bytes(7)])
        await store.saveSnapshot({ docRef: DOC, ...payload, frontier: bytes(9, 9) })

        const loaded = await store.loadSnapshot({ docRef: DOC })
        expect(loaded?.manifest).toEqual(payload.manifest)
        expect(loaded?.chunks.map((chunk) => [chunk.index, chunk.of, [...chunk.bytes]])).toEqual([
          [0, 3, [1, 2, 3, 4]],
          [1, 3, [5, 6]],
          [2, 3, [7]],
        ])
        expect([...(loaded?.frontier ?? [])]).toEqual([9, 9])
      })
    })

    it('returns chunks in index order however they were supplied', async () => {
      // Nothing in the contract says a caller saves them in order, and a
      // store that returns insertion order makes reassembly depend on how it
      // was written rather than on what it holds.
      await withStore(async (store) => {
        const payload = chunked([bytes(1, 2), bytes(3, 4), bytes(5, 6)])
        await store.saveSnapshot({
          docRef: DOC,
          manifest: payload.manifest,
          chunks: [payload.chunks[2], payload.chunks[0], payload.chunks[1]] as SnapshotChunk[],
          frontier: bytes(1),
        })
        const loaded = await store.loadSnapshot({ docRef: DOC })
        expect(loaded?.chunks.map((chunk) => chunk.index)).toEqual([0, 1, 2])
      })
    })

    it('distinguishes an empty snapshot from one never saved', async () => {
      // `chunkCount: 0` is a document that exists and holds no bytes. A store
      // that folds it into "absent" loses the difference between a saved
      // empty document and one that was never there.
      await withStore(async (store) => {
        await store.saveSnapshot({ docRef: DOC, ...EMPTY, frontier: bytes(4) })
        const loaded = await store.loadSnapshot({ docRef: DOC })
        expect(loaded).not.toBeNull()
        expect(loaded?.manifest.chunkCount).toBe(0)
        expect(loaded?.chunks).toEqual([])
      })
    })

    it('leaves no orphan when a replacement snapshot has fewer chunks', async () => {
      await withStore(async (store) => {
        await store.saveSnapshot({
          docRef: DOC,
          ...chunked([bytes(1, 2), bytes(3, 4), bytes(5, 6)]),
          frontier: bytes(1),
        })
        await store.saveSnapshot({
          docRef: DOC,
          ...chunked([bytes(7, 8)]),
          frontier: bytes(2),
        })
        const loaded = await store.loadSnapshot({ docRef: DOC })
        expect(loaded?.manifest.chunkCount).toBe(1)
        expect(loaded?.chunks.map((chunk) => [...chunk.bytes])).toEqual([[7, 8]])
      })
    })

    it('reports the current frontier from loadSnapshot, not the saved one', async () => {
      await withStore(async (store) => {
        await store.saveSnapshot({ docRef: DOC, ...chunked([bytes(1)]), frontier: bytes(1) })
        await store.appendDeltas({
          docRef: DOC,
          deltaBatch: { updates: [bytes(2)], newFrontier: bytes(2, 2) },
        })
        expect([...((await store.loadSnapshot({ docRef: DOC }))?.frontier ?? [])]).toEqual([2, 2])
        expect([...((await store.readFrontier({ docRef: DOC }))?.frontier ?? [])]).toEqual([2, 2])
      })
    })

    it('appendDeltas answers the new frontier and accumulates across batches', async () => {
      await withStore(async (store) => {
        const first = await store.appendDeltas({
          docRef: DOC,
          deltaBatch: { updates: [bytes(1)], newFrontier: bytes(1) },
        })
        expect([...first.frontier]).toEqual([1])
        await store.appendDeltas({
          docRef: DOC,
          deltaBatch: { updates: [bytes(2), bytes(3)], newFrontier: bytes(3) },
        })
        const loaded = await store.loadDeltas({ docRef: DOC, sinceFrontier: bytes() })
        expect(loaded.updates.map((update) => [...update])).toEqual([[1], [2], [3]])
        expect([...loaded.frontier]).toEqual([3])
      })
    })

    it('ignores sinceFrontier and returns the whole log', async () => {
      await withStore(async (store) => {
        await store.appendDeltas({
          docRef: DOC,
          deltaBatch: { updates: [bytes(1), bytes(2)], newFrontier: bytes(2) },
        })
        const loaded = await store.loadDeltas({ docRef: DOC, sinceFrontier: bytes(2) })
        expect(loaded.updates.map((update) => [...update])).toEqual([[1], [2]])
      })
    })

    it('keeps two documents apart', async () => {
      await withStore(async (store) => {
        await store.saveSnapshot({ docRef: DOC, ...chunked([bytes(1)]), frontier: bytes(1) })
        await store.appendDeltas({
          docRef: DOC,
          deltaBatch: { updates: [bytes(9)], newFrontier: bytes(9) },
        })
        expect(await store.loadSnapshot({ docRef: OTHER })).toBeNull()
        expect((await store.loadDeltas({ docRef: OTHER, sinceFrontier: bytes() })).updates).toEqual(
          [],
        )
      })
    })

    it('keeps a document apart from a workspace-tree sharing its id shape', async () => {
      await withStore(async (store) => {
        await store.saveSnapshot({ docRef: TREE, ...chunked([bytes(7)]), frontier: bytes(7) })
        expect(await store.loadSnapshot({ docRef: DOC })).toBeNull()
        expect([...((await store.loadSnapshot({ docRef: TREE }))?.frontier ?? [])]).toEqual([7])
      })
    })

    it('deleteDoc removes the snapshot, the frontier and the deltas together', async () => {
      await withStore(async (store) => {
        await store.saveSnapshot({ docRef: DOC, ...chunked([bytes(1)]), frontier: bytes(1) })
        await store.appendDeltas({
          docRef: DOC,
          deltaBatch: { updates: [bytes(2)], newFrontier: bytes(2) },
        })
        await store.saveSnapshot({ docRef: OTHER, ...chunked([bytes(5)]), frontier: bytes(5) })

        await store.deleteDoc({ docRef: DOC })

        expect(await store.loadSnapshot({ docRef: DOC })).toBeNull()
        expect(await store.readFrontier({ docRef: DOC })).toBeNull()
        expect((await store.loadDeltas({ docRef: DOC, sinceFrontier: bytes() })).updates).toEqual(
          [],
        )
        // The neighbour is untouched — a delete that takes the store with it
        // would pass every assertion above.
        expect(await store.loadSnapshot({ docRef: OTHER })).not.toBeNull()
      })
    })

    it('deleting a document that was never there succeeds', async () => {
      await withStore(async (store) => {
        await expect(store.deleteDoc({ docRef: DOC })).resolves.toBeUndefined()
      })
    })

    it('hands back independent buffers, in both directions', async () => {
      // The arrays a caller passes in stay theirs, and the ones they get back
      // are theirs too. A store that shares either reference lets one caller's
      // edit rewrite what the next one reads.
      await withStore(async (store) => {
        const mine = bytes(1, 2, 3, 4)
        const frontier = bytes(8)
        await store.saveSnapshot({
          docRef: DOC,
          manifest: { chunkCount: 1, totalBytes: 4, maxChunkBytes: 4 },
          chunks: [{ index: 0, of: 1, bytes: mine }],
          frontier,
        })
        mine[0] = 99
        frontier[0] = 99

        const first = await store.loadSnapshot({ docRef: DOC })
        expect([...(first?.chunks[0]?.bytes ?? [])]).toEqual([1, 2, 3, 4])
        expect([...(first?.frontier ?? [])]).toEqual([8])

        const chunk = first?.chunks[0]?.bytes
        if (chunk) chunk[0] = 42
        const second = await store.loadSnapshot({ docRef: DOC })
        expect([...(second?.chunks[0]?.bytes ?? [])]).toEqual([1, 2, 3, 4])
      })
    })
  })
}
