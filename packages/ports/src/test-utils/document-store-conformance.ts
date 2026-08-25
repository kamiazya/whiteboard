import { describe, expect, it } from 'vitest'
import type { DocRef, DocumentStore, SnapshotChunk } from '../index.js'
import { isStoredDocumentUnreadableError } from '../index.js'

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
  makeStore: () => Promise<{
    store: DocumentStore
    dispose: () => Promise<void>
    /**
     * Put a record the store cannot read where `docRef`'s record goes.
     *
     * REQUIRED rather than optional, and that is deliberate: every store can
     * reach its own storage, and an optional seam here would let the
     * guarantee below be silently skipped by exactly the implementation that
     * needed checking.
     *
     * No `code` parameter, because only `malformed` is universal. A store
     * whose records are versioned ENVELOPES can also be handed one from a
     * newer version; a store whose records are typed COLUMNS cannot be in
     * that state at all. So the shared bar is "it throws rather than
     * answering null", and which codes an implementation can tell apart is
     * its own test's business.
     */
    writeUnreadableRecord: (docRef: DocRef) => Promise<void>
  }>,
): void {
  async function withStore(
    body: (
      store: DocumentStore,
      writeUnreadableRecord: (docRef: DocRef) => Promise<void>,
    ) => Promise<void>,
  ): Promise<void> {
    const { store, dispose, writeUnreadableRecord } = await makeStore()
    try {
      await body(store, writeUnreadableRecord)
    } finally {
      await dispose()
    }
  }

  const DOC: DocRef = { kind: 'document', documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }
  const OTHER: DocRef = { kind: 'document', documentId: '01BX5ZZKBKACTAV9WEVGEMMVRZ' }
  // Same id STRING as a workspace would use, different kind. The key a store
  // derives has to keep these apart.
  // The SAME identifier string as DOC, so a store that keys on the id alone
  // and drops `kind` fails the case below. With two different strings it
  // passes without ever exercising what it claims to.
  const TREE: DocRef = { kind: 'workspace-tree', workspaceId: DOC.documentId }

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

    /**
     * `readSnapshotManifest` exists so a caller that only needs to know
     * whether there is a base to append to does not have to pull the base
     * itself. Its whole worth is that it is CHEAP, and the only thing that
     * can quietly take that away is an implementation that answers it by
     * calling `loadSnapshot` and discarding the chunks.
     *
     * That cannot be asserted from out here — a shared suite sees answers,
     * not the work behind them. What IS asserted is the part a caller relies
     * on: it agrees with `loadSnapshot` about whether a snapshot is there,
     * in every state this suite can put a store in, and it refuses the same
     * records rather than reporting them absent.
     */
    it('answers null for a snapshot that is not there', async () => {
      await withStore(async (store) => {
        expect(await store.readSnapshotManifest({ docRef: DOC })).toBeNull()
        // A document with a delta log but no snapshot is still a document
        // with no base: appending is legal without one, and the manifest is
        // what says so.
        await store.appendDeltas({
          docRef: DOC,
          deltaBatch: { updates: [bytes(1)], newFrontier: bytes(7) },
        })
        expect(await store.readSnapshotManifest({ docRef: DOC })).toBeNull()
        expect(await store.loadSnapshot({ docRef: DOC })).toBeNull()
      })
    })

    it('answers the manifest of the stored snapshot, matching loadSnapshot', async () => {
      await withStore(async (store) => {
        const payload = chunked([bytes(1, 2, 3, 4), bytes(5, 6), bytes(7)])
        await store.saveSnapshot({ docRef: DOC, ...payload, frontier: bytes(9, 9) })

        expect(await store.readSnapshotManifest({ docRef: DOC })).toEqual(payload.manifest)
        // The same value `loadSnapshot` reports, not merely a plausible one.
        expect(await store.readSnapshotManifest({ docRef: DOC })).toEqual(
          (await store.loadSnapshot({ docRef: DOC }))?.manifest,
        )
        // Scoped like every other operation: another document's snapshot is
        // not this one's.
        expect(await store.readSnapshotManifest({ docRef: OTHER })).toBeNull()
        expect(await store.readSnapshotManifest({ docRef: TREE })).toBeNull()
      })
    })

    it('follows the snapshot through a delete and a compaction', async () => {
      await withStore(async (store) => {
        await store.saveSnapshot({
          docRef: DOC,
          ...chunked([bytes(1, 2, 3, 4), bytes(5)]),
          frontier: bytes(1),
        })
        await store.appendDeltas({
          docRef: DOC,
          deltaBatch: { updates: [bytes(8)], newFrontier: bytes(2) },
        })
        const compacted = chunked([bytes(9, 9, 9)])
        await store.saveCompactedSnapshot({
          docRef: DOC,
          ...compacted,
          frontier: bytes(3),
          supersededDeltaCount: 1,
        })
        expect(await store.readSnapshotManifest({ docRef: DOC })).toEqual(compacted.manifest)

        await store.deleteDoc({ docRef: DOC })
        expect(await store.readSnapshotManifest({ docRef: DOC })).toBeNull()
      })
    })

    it('refuses an unreadable record rather than reporting it absent', async () => {
      await withStore(async (store, writeUnreadableRecord) => {
        await writeUnreadableRecord(DOC)
        // The same refusal `loadSnapshot` gives. Answering `null` here would
        // tell a caller "there is no base, start fresh" about a document
        // whose bytes are sitting right there.
        await expect(store.readSnapshotManifest({ docRef: DOC })).rejects.toSatisfy(
          isStoredDocumentUnreadableError,
        )
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

    it('saveCompactedSnapshot replaces the snapshot AND drops the log', async () => {
      // The one operation `saveSnapshot` is not. Folding needs the CRDT
      // runtime a store does not have, so the caller folds and then says so —
      // and it has to be ONE call, because save-then-clear has a window where
      // a concurrent append is dropped.
      await withStore(async (store) => {
        await store.saveSnapshot({ docRef: DOC, ...chunked([bytes(1)]), frontier: bytes(1) })
        await store.appendDeltas({
          docRef: DOC,
          deltaBatch: { updates: [bytes(2), bytes(3)], newFrontier: bytes(3) },
        })

        await store.saveCompactedSnapshot({
          docRef: DOC,
          ...chunked([bytes(1, 2, 3)]),
          frontier: bytes(3),
          supersededDeltaCount: 2,
        })

        const loaded = await store.loadSnapshot({ docRef: DOC })
        expect(loaded?.chunks.map((chunk) => [...chunk.bytes])).toEqual([[1, 2, 3]])
        expect((await store.loadDeltas({ docRef: DOC, sinceFrontier: bytes() })).updates).toEqual(
          [],
        )
        // The frontier is NOT rolled back to before the deltas: they are in
        // the snapshot now, so the document is still as far along as it was.
        expect([...((await store.readFrontier({ docRef: DOC }))?.frontier ?? [])]).toEqual([3])
      })
    })

    it('saveCompactedSnapshot leaves a neighbour log alone', async () => {
      await withStore(async (store) => {
        await store.appendDeltas({
          docRef: OTHER,
          deltaBatch: { updates: [bytes(9)], newFrontier: bytes(9) },
        })
        await store.saveCompactedSnapshot({
          docRef: DOC,
          ...chunked([bytes(1)]),
          frontier: bytes(1),
          supersededDeltaCount: 0,
        })
        expect(
          (await store.loadDeltas({ docRef: OTHER, sinceFrontier: bytes() })).updates.length,
        ).toBe(1)
      })
    })

    it('saveCompactedSnapshot does not drop an append that races it', async () => {
      // The whole reason this is ONE operation. A store that saves the
      // snapshot, yields, and then clears the log has a window where an
      // append lands and is thrown away — and the appended update is NOT in
      // the compacted snapshot, because the caller folded before it existed.
      //
      // Started without awaiting, so the append is issued while the
      // compaction is in flight rather than after it. Either outcome is
      // correct — the store may serialise them — but the update must not
      // VANISH: it is either in the log or the compaction happened first.
      await withStore(async (store) => {
        await store.saveSnapshot({ docRef: DOC, ...chunked([bytes(1)]), frontier: bytes(1) })
        await store.appendDeltas({
          docRef: DOC,
          deltaBatch: { updates: [bytes(2)], newFrontier: bytes(2) },
        })

        const compacting = store.saveCompactedSnapshot({
          docRef: DOC,
          ...chunked([bytes(1, 2)]),
          frontier: bytes(2),
          // One entry folded: `[2]`. `[3]` had not arrived.
          supersededDeltaCount: 1,
        })
        const appending = store.appendDeltas({
          docRef: DOC,
          deltaBatch: { updates: [bytes(3)], newFrontier: bytes(3) },
        })
        await Promise.all([compacting, appending])

        const { updates } = await store.loadDeltas({ docRef: DOC, sinceFrontier: bytes() })
        // `[3]` MUST survive. It cannot be in the compacted snapshot: the
        // caller folded before it existed. So a store that cleared it lost an
        // edit — which is the only outcome this case rejects, and an empty
        // log is exactly that outcome rather than an alternative to it.
        expect(updates.map((update) => [...update])).toContainEqual([3])
      })
    })

    it('deleting a document that was never there succeeds', async () => {
      await withStore(async (store) => {
        await expect(store.deleteDoc({ docRef: DOC })).resolves.toBeUndefined()
      })
    })

    it('throws rather than answering null when a record is there but unreadable', async () => {
      // The distinction the port exists to preserve. `null` means "no such
      // document"; a record that is present and unreadable is a document that
      // IS there, and telling its owner it is missing is the wrong sentence
      // about their own data.
      await withStore(async (store, writeUnreadable) => {
        await writeUnreadable(DOC)
        await expect(store.loadSnapshot({ docRef: DOC })).rejects.toSatisfy(
          isStoredDocumentUnreadableError,
        )
      })
    })

    it('an unreadable record does not make its NEIGHBOURS unreadable', async () => {
      await withStore(async (store, writeUnreadable) => {
        await store.saveSnapshot({ docRef: OTHER, ...chunked([bytes(5)]), frontier: bytes(5) })
        await writeUnreadable(DOC)
        expect(await store.loadSnapshot({ docRef: OTHER })).not.toBeNull()
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
