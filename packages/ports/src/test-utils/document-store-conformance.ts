import { describe, expect, it } from 'vitest'
import type { DocRef, DocumentStore, SaveCompactedSnapshotInput, SnapshotChunk } from '../index.js'
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
 * - **`loadDeltas` tails by SEQ, not by frontier.** Comparing frontiers needs
 *   the loro-crdt runtime, which a store does not have — `Frontier` is an
 *   opaque `Uint8Array` at this layer. The seq a store already assigns costs
 *   it nothing. The cursor is the PAIR `(generation, afterSeq)`: a seq is
 *   monotonic only within a generation, because a fold that empties the log
 *   lets the next append reuse seqs a caller has already consumed.
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

  const DOC_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
  const DOC: DocRef = { kind: 'document', workspaceId: 'conformance-ws', documentId: DOC_ID }
  const OTHER: DocRef = {
    kind: 'document',
    workspaceId: 'conformance-ws',
    documentId: '01BX5ZZKBKACTAV9WEVGEMMVRZ',
  }
  // Same id STRING as a workspace would use, different kind. The key a store
  // derives has to keep these apart.
  // The SAME identifier string as DOC, so a store that keys on the id alone
  // and drops `kind` fails the case below. With two different strings it
  // passes without ever exercising what it claims to.
  const TREE: DocRef = { kind: 'workspace-tree', workspaceId: DOC_ID }

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

  /**
   * Fold, reading the fence immediately before and asserting the write was
   * ACCEPTED.
   *
   * A refused fold does nothing and returns, so a case that merely called
   * `saveCompactedSnapshot` and then asserted the result would pass against a
   * store that refused every one of them — the assertions would be reading
   * the state the fold was supposed to change, unchanged. Every case below
   * that folds as a SETUP step goes through here; the cases that are ABOUT
   * refusal call the port directly.
   */
  async function foldAccepted(
    store: DocumentStore,
    input: Omit<SaveCompactedSnapshotInput, 'expectedGeneration'>,
  ): Promise<void> {
    const read = await store.readSnapshotManifest({ docRef: input.docRef })
    const result = await store.saveCompactedSnapshot({
      ...input,
      expectedGeneration: read?.generation ?? null,
    })
    if (!result.ok) throw new Error('expected the fold to be accepted')
  }

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

        expect((await store.readSnapshotManifest({ docRef: DOC }))?.manifest).toEqual(
          payload.manifest,
        )
        // The same value `loadSnapshot` reports, not merely a plausible one.
        expect((await store.readSnapshotManifest({ docRef: DOC }))?.manifest).toEqual(
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
        await foldAccepted(store, {
          docRef: DOC,
          ...compacted,
          frontier: bytes(3),
          supersededDeltaCount: 1,
        })
        expect((await store.readSnapshotManifest({ docRef: DOC }))?.manifest).toEqual(
          compacted.manifest,
        )

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
        const result = await store.loadDeltas({ docRef: DOC, afterSeq: null })
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
        const loaded = await store.loadDeltas({ docRef: DOC, afterSeq: null })
        expect(loaded.updates.map((update) => [...update])).toEqual([[1], [2], [3]])
        expect([...loaded.frontier]).toEqual([3])
      })
    })

    /**
     * The incremental tail, which `sinceFrontier` promised and no
     * implementation ever delivered.
     *
     * It is a SEQ and not a frontier because comparing frontiers needs the
     * loro-crdt runtime and a store does not have one — `Frontier` is an
     * opaque `Uint8Array` at this layer. A seq the store already assigns
     * costs it nothing, and CRDT updates are idempotent, so a cursor that
     * over-delivers is merely slower rather than wrong.
     */
    it('answers only the log after the cursor, and says where to resume', async () => {
      await withStore(async (store) => {
        await store.appendDeltas({
          docRef: DOC,
          deltaBatch: { updates: [bytes(1), bytes(2)], newFrontier: bytes(2) },
        })
        const all = await store.loadDeltas({ docRef: DOC, afterSeq: null })
        expect(all.updates.map((update) => [...update])).toEqual([[1], [2]])
        expect(all.lastSeq).not.toBeNull()

        await store.appendDeltas({
          docRef: DOC,
          deltaBatch: { updates: [bytes(3)], newFrontier: bytes(3) },
        })
        const tail = await store.loadDeltas({ docRef: DOC, afterSeq: all.lastSeq })
        expect(tail.updates.map((update) => [...update])).toEqual([[3]])
        // Resuming from the new cursor answers nothing, and keeps answering
        // nothing — a tail that re-delivered its last batch forever would
        // pass every assertion above.
        const caughtUp = await store.loadDeltas({ docRef: DOC, afterSeq: tail.lastSeq })
        expect(caughtUp.updates).toEqual([])
        expect(caughtUp.lastSeq).toBe(tail.lastSeq)
      })
    })

    it('reports no cursor for a log that is empty', async () => {
      await withStore(async (store) => {
        expect((await store.loadDeltas({ docRef: DOC, afterSeq: null })).lastSeq).toBeNull()
      })
    })

    /**
     * Why the cursor is a PAIR, and the one thing a tailing reader must not
     * get wrong.
     *
     * A seq is monotonic only within a generation. `appendDeltas` assigns
     * from the highest seq present, so a fold that empties the log lets the
     * next append reuse seqs the caller has already consumed — and a tail
     * holding one of them would skip real updates. The fold changes the
     * generation, which is the signal that the prefix is gone and the
     * snapshot has to be re-read; `loadDeltas` reports it for exactly that.
     */
    it('reports the snapshot generation alongside the log, and changes it on a fold', async () => {
      await withStore(async (store) => {
        await store.saveSnapshot({ docRef: DOC, ...chunked([bytes(1)]), frontier: bytes(1) })
        await store.appendDeltas({
          docRef: DOC,
          deltaBatch: { updates: [bytes(2)], newFrontier: bytes(2) },
        })
        const before = await store.loadDeltas({ docRef: DOC, afterSeq: null })
        expect(before.generation).not.toBeNull()

        await foldAccepted(store, {
          docRef: DOC,
          ...chunked([bytes(1, 2)]),
          frontier: bytes(2),
          supersededDeltaCount: 1,
        })
        const after = await store.loadDeltas({ docRef: DOC, afterSeq: before.lastSeq })
        expect(after.generation).not.toBe(before.generation)
      })
    })

    it('reports a null generation for a log with no snapshot behind it', async () => {
      await withStore(async (store) => {
        await store.appendDeltas({
          docRef: DOC,
          deltaBatch: { updates: [bytes(1)], newFrontier: bytes(1) },
        })
        expect((await store.loadDeltas({ docRef: DOC, afterSeq: null })).generation).toBeNull()
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
        expect((await store.loadDeltas({ docRef: OTHER, afterSeq: null })).updates).toEqual([])
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
        expect((await store.loadDeltas({ docRef: DOC, afterSeq: null })).updates).toEqual([])
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

        await foldAccepted(store, {
          docRef: DOC,
          ...chunked([bytes(1, 2, 3)]),
          frontier: bytes(3),
          supersededDeltaCount: 2,
        })

        const loaded = await store.loadSnapshot({ docRef: DOC })
        expect(loaded?.chunks.map((chunk) => [...chunk.bytes])).toEqual([[1, 2, 3]])
        expect((await store.loadDeltas({ docRef: DOC, afterSeq: null })).updates).toEqual([])
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
        await foldAccepted(store, {
          docRef: DOC,
          ...chunked([bytes(1)]),
          frontier: bytes(1),
          supersededDeltaCount: 0,
        })
        expect((await store.loadDeltas({ docRef: OTHER, afterSeq: null })).updates.length).toBe(1)
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

        const compacting = foldAccepted(store, {
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

        const { updates } = await store.loadDeltas({ docRef: DOC, afterSeq: null })
        // `[3]` MUST survive. It cannot be in the compacted snapshot: the
        // caller folded before it existed. So a store that cleared it lost an
        // edit — which is the only outcome this case rejects, and an empty
        // log is exactly that outcome rather than an alternative to it.
        expect(updates.map((update) => [...update])).toContainEqual([3])
      })
    })

    /**
     * ADR-0020. The count above protects a concurrent APPEND; nothing
     * protected a concurrent COMPACTION, and that one loses ops outright
     * rather than merely reordering them: the folding caller's own new ops go
     * into the snapshot and were never appended as a delta, so when a second
     * folder replaces that snapshot they exist nowhere. A generation read
     * with the manifest and presented back on the write is what makes the
     * replace conditional.
     */
    it('refuses a fold whose generation another writer already replaced', async () => {
      await withStore(async (store) => {
        await store.saveSnapshot({ docRef: DOC, ...chunked([bytes(1)]), frontier: bytes(1) })
        await store.appendDeltas({
          docRef: DOC,
          deltaBatch: { updates: [bytes(2)], newFrontier: bytes(2) },
        })
        const read = await store.readSnapshotManifest({ docRef: DOC })
        if (read === null) throw new Error('expected a stored snapshot')

        // Two writers folded the same log and hold the same generation.
        const winner = await store.saveCompactedSnapshot({
          docRef: DOC,
          ...chunked([bytes(1, 2)]),
          frontier: bytes(2),
          supersededDeltaCount: 1,
          expectedGeneration: read.generation,
        })
        expect(winner.ok).toBe(true)

        const loser = await store.saveCompactedSnapshot({
          docRef: DOC,
          ...chunked([bytes(9)]),
          frontier: bytes(9),
          supersededDeltaCount: 1,
          expectedGeneration: read.generation,
        })
        expect(loser.ok).toBe(false)
        if (loser.ok) throw new Error('unreachable')
        // Reported so the loser can re-read rather than guess.
        expect(loser.currentGeneration).not.toBe(read.generation)

        // The refusal is total: the loser wrote no chunks, no frontier, and
        // deleted no deltas. Asserting the stored bytes rather than only the
        // flag is what catches a store that reports `ok: false` after
        // half-applying the write.
        const stored = await store.loadSnapshot({ docRef: DOC })
        expect(stored?.chunks.flatMap((chunk) => [...chunk.bytes])).toEqual([1, 2])
      })
    })

    it('refuses a first snapshot when another writer already created one', async () => {
      await withStore(async (store) => {
        const winner = await store.saveCompactedSnapshot({
          docRef: DOC,
          ...chunked([bytes(1)]),
          frontier: bytes(1),
          supersededDeltaCount: 0,
          // `null` is "expect no snapshot" — the create half of the same
          // conditional write, so a caller racing to mint a document does not
          // need a second operation with its own semantics.
          expectedGeneration: null,
        })
        expect(winner.ok).toBe(true)

        const loser = await store.saveCompactedSnapshot({
          docRef: DOC,
          ...chunked([bytes(9)]),
          frontier: bytes(9),
          supersededDeltaCount: 0,
          expectedGeneration: null,
        })
        expect(loser.ok).toBe(false)

        const stored = await store.loadSnapshot({ docRef: DOC })
        expect(stored?.chunks.flatMap((chunk) => [...chunk.bytes])).toEqual([1])
      })
    })

    /**
     * `saveSnapshot` stays UNCONDITIONAL — it is the authoritative write
     * (create, import, restore), where the caller's content is the answer
     * rather than a fold of what it read. It must still advance the
     * generation, or a fold of the content it replaced would be accepted
     * afterwards and silently undo it.
     */
    it('advances the generation on an authoritative overwrite', async () => {
      await withStore(async (store) => {
        await store.saveSnapshot({ docRef: DOC, ...chunked([bytes(1)]), frontier: bytes(1) })
        const before = await store.readSnapshotManifest({ docRef: DOC })
        if (before === null) throw new Error('expected a stored snapshot')

        await store.saveSnapshot({ docRef: DOC, ...chunked([bytes(5)]), frontier: bytes(5) })
        const after = await store.readSnapshotManifest({ docRef: DOC })
        if (after === null) throw new Error('expected a stored snapshot')
        expect(after.generation).not.toBe(before.generation)

        const stale = await store.saveCompactedSnapshot({
          docRef: DOC,
          ...chunked([bytes(1, 2)]),
          frontier: bytes(2),
          supersededDeltaCount: 0,
          expectedGeneration: before.generation,
        })
        expect(stale.ok).toBe(false)
        const stored = await store.loadSnapshot({ docRef: DOC })
        expect(stored?.chunks.flatMap((chunk) => [...chunk.bytes])).toEqual([5])
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
