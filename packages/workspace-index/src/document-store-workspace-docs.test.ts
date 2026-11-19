/**
 * `save` answers the bytes it persisted, because the daemon's sync fan-out
 * needs exactly that update to hand to other subscribers — re-deriving it
 * after the fact would race the next save. `null` means nothing was written,
 * so a caller can skip the fan-out instead of broadcasting a 22-byte empty
 * envelope on every idle save.
 */
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
  SnapshotManifest,
} from '@kamiazya/whiteboard-ports'
import { docRefKey } from '@kamiazya/whiteboard-ports'
import { describe, expect, it, vi } from 'vitest'
import {
  type DocumentStoreWorkspaceDocsOptions,
  RecordStoreWorkspaceDocs,
} from './document-store-workspace-docs.js'
import { RECORD_SUBJECTS } from './test-utils/record-subjects.js'

interface StoredDoc {
  manifest: SnapshotManifest | null
  chunks: SaveSnapshotInput['chunks']
  frontier: Uint8Array<ArrayBuffer>
  deltas: Uint8Array<ArrayBuffer>[]
  /** The seq the next appended update gets — implemented rather than stubbed,
   *  so this double cannot report a cursor the real stores would not. */
  nextSeq: number
  /** ADR-0020's fence, implemented for real here: the save path's refusal
   *  branch is only reachable against a store that can refuse. */
  generation: number
}

/** Just enough of a `DocumentStore` for the save/append/compact paths. */
class FakeDocumentStore implements DocumentStore {
  readonly docs = new Map<string, StoredDoc>()

  /**
   * Runs at the TOP of `saveCompactedSnapshot`, which is the one place a
   * rival writer can be made to land between a caller's fence read and its
   * write. Without a seam here the refusal branch is unreachable from a test,
   * and a fallback nothing reaches is a fallback nobody knows is broken.
   */
  beforeCompact: (() => Promise<void>) | undefined

  /**
   * How many folds this store REFUSED.
   *
   * Asserted by the race cases rather than left implicit: both of them pass
   * against a store that never refused anything — the ops survive because
   * nothing raced — so without this the cases would be testing the ordinary
   * path under a name that claims otherwise. The first draft of the fold case
   * did exactly that, and only a mutation check found it.
   */
  refusals = 0

  /**
   * Runs at the TOP of `loadDeltas` — the read-side twin of `beforeCompact`.
   * `open()` reads the snapshot and the log in two calls, and this is the one
   * place a rival fold can be made to land between them. Without it the
   * straddle is unreachable from a test, and a reader that quietly answers a
   * stale document is a reader nobody knows is stale.
   */
  beforeLoadDeltas: (() => Promise<void>) | undefined

  async loadSnapshot({ docRef }: LoadSnapshotInput): Promise<LoadSnapshotResult> {
    const stored = this.docs.get(docRefKey(docRef))
    if (stored === undefined || stored.manifest === null) return null
    return { manifest: stored.manifest, chunks: stored.chunks, frontier: stored.frontier }
  }

  async readSnapshotManifest({
    docRef,
  }: ReadSnapshotManifestInput): Promise<ReadSnapshotManifestResult> {
    const stored = this.docs.get(docRefKey(docRef))
    if (stored === undefined || stored.manifest === null) return null
    return { manifest: stored.manifest, generation: stored.generation }
  }

  async saveSnapshot({ docRef, manifest, chunks, frontier }: SaveSnapshotInput): Promise<void> {
    const previous = this.docs.get(docRefKey(docRef))
    this.docs.set(docRefKey(docRef), {
      manifest,
      chunks,
      frontier,
      deltas: [],
      nextSeq: previous?.nextSeq ?? 1,
      generation: (previous?.generation ?? 0) + 1,
    })
  }

  async saveCompactedSnapshot({
    docRef,
    manifest,
    chunks,
    frontier,
    supersededDeltaCount,
    expectedGeneration,
  }: SaveCompactedSnapshotInput): Promise<SaveCompactedSnapshotResult> {
    if (this.beforeCompact !== undefined) await this.beforeCompact()
    const stored = this.docs.get(docRefKey(docRef))
    const current = stored === undefined || stored.manifest === null ? null : stored.generation
    if (current !== expectedGeneration) {
      this.refusals += 1
      return { ok: false, currentGeneration: current }
    }
    const surviving = stored === undefined ? [] : stored.deltas.slice(supersededDeltaCount)
    const generation = (current ?? 0) + 1
    this.docs.set(docRefKey(docRef), {
      manifest,
      chunks,
      frontier,
      deltas: surviving,
      nextSeq: stored?.nextSeq ?? 1,
      generation,
    })
    return { ok: true, generation }
  }

  async appendDeltas({
    docRef,
    deltaBatch,
    requireSnapshot,
  }: AppendDeltasInput): Promise<AppendDeltasResult> {
    const stored = this.docs.get(docRefKey(docRef))
    if (stored === undefined || stored.manifest === null) {
      if (requireSnapshot === true) return { ok: false, reason: 'no-snapshot' }
      throw new Error('append without a snapshot')
    }
    stored.deltas.push(...deltaBatch.updates)
    stored.nextSeq += deltaBatch.updates.length
    stored.frontier = deltaBatch.newFrontier
    return { ok: true, frontier: stored.frontier }
  }

  async loadDeltas(input: LoadDeltasInput): Promise<LoadDeltasResult> {
    if (this.beforeLoadDeltas !== undefined) await this.beforeLoadDeltas()
    return this.loadDeltasReal(input)
  }

  /** The real body, so a spy on `loadDeltas` can observe the call and still
   *  answer truthfully rather than having to reimplement the store. */
  async loadDeltasReal({ docRef, afterSeq }: LoadDeltasInput): Promise<LoadDeltasResult> {
    const stored = this.docs.get(docRefKey(docRef))
    if (stored === undefined) {
      return { updates: [], lastSeq: null, generation: null, frontier: new Uint8Array() }
    }
    const firstSeq = stored.nextSeq - stored.deltas.length
    const after = afterSeq ?? firstSeq - 1
    return {
      updates: stored.deltas.filter((_, index) => firstSeq + index > after),
      lastSeq: stored.deltas.length === 0 ? null : stored.nextSeq - 1,
      generation: stored.manifest === null ? null : stored.generation,
      frontier: stored.frontier,
    }
  }

  async readFrontier({ docRef }: ReadFrontierInput): Promise<ReadFrontierResult> {
    const stored = this.docs.get(docRefKey(docRef))
    return stored === undefined ? null : { frontier: stored.frontier }
  }

  async deleteDoc({ docRef }: DeleteDocInput): Promise<void> {
    this.docs.delete(docRefKey(docRef))
  }
}

describe.each(RECORD_SUBJECTS)('a workspace record held as $name', (subject) => {
  const docsOver = (store: DocumentStore, options?: DocumentStoreWorkspaceDocsOptions) =>
    new RecordStoreWorkspaceDocs(store, subject.kind, options)
  const valueIn = (record: unknown, key: string): string | undefined =>
    record === null ? undefined : subject.get(record, key)

  it('the first save answers bytes that bring an empty peer to the saved state', async () => {
    const docs = docsOver(new FakeDocumentStore())
    const doc = await subject.fresh()
    subject.put(doc, 'title', 'first')

    const update = await docs.save('ws-a', doc)
    expect(update).not.toBeNull()
    if (update === null) return
    const peer = await subject.fresh()
    subject.kind.importInto(peer, update)
    expect(subject.get(peer, 'title')).toBe('first')
  })

  it('a refused mint writes nothing, and the keeper is asked only when minting', async () => {
    const store = new FakeDocumentStore()
    const refused = new Error('removed')
    const beforeMint = vi.fn(async (workspaceId: string) => {
      if (workspaceId === 'ws-removed') throw refused
    })
    const docs = docsOver(store, { beforeMint })
    const doc = await subject.fresh()
    subject.put(doc, 'title', 'held')

    await expect(docs.save('ws-removed', doc)).rejects.toBe(refused)
    await expect(docs.create('ws-removed')).rejects.toBe(refused)
    expect(await docs.open('ws-removed')).toBeNull()

    await docs.save('ws-a', doc)
    subject.put(doc, 'title', 'edited')
    await docs.save('ws-a', doc)
    expect(beforeMint.mock.calls.filter(([id]) => id === 'ws-a')).toHaveLength(1)
  })

  it('an incremental save answers exactly the delta a caught-up peer needs', async () => {
    const docs = docsOver(new FakeDocumentStore())
    const doc = await subject.fresh()
    subject.put(doc, 'title', 'first')
    const first = await docs.save('ws-a', doc)
    expect(first).not.toBeNull()
    if (first === null) return
    const peer = await subject.fresh()
    subject.kind.importInto(peer, first)

    subject.put(doc, 'title', 'second')
    const second = await docs.save('ws-a', doc)
    expect(second).not.toBeNull()
    if (second === null) return
    subject.kind.importInto(peer, second)
    expect(subject.get(peer, 'title')).toBe('second')
  })

  it('an idle save answers null', async () => {
    const store = new FakeDocumentStore()
    const docs = docsOver(store)
    const doc = await subject.fresh()
    subject.put(doc, 'title', 'only')
    await docs.save('ws-a', doc)

    expect(await docs.save('ws-a', doc)).toBeNull()
  })

  it('a save that folds the log still answers the delta, not the whole snapshot', async () => {
    const docs = docsOver(new FakeDocumentStore())
    const doc = await subject.fresh()
    subject.put(doc, 'seed', 'seed')
    const first = await docs.save('ws-a', doc)
    expect(first).not.toBeNull()
    if (first === null) return
    const peer = await subject.fresh()
    subject.kind.importInto(peer, first)

    // Big enough that shouldCompact trips (64 KiB of delta bytes).
    subject.put(doc, 'bulk', 'x'.repeat(80_000))
    const update = await docs.save('ws-a', doc)
    expect(update).not.toBeNull()
    if (update === null) return
    subject.kind.importInto(peer, update)
    expect(subject.entries(peer)).toEqual(subject.entries(doc))
  })

  /**
   * ADR-0020's refusal branch, from both sides it can be reached.
   *
   * The assertion that matters is not that the write was refused — it is that
   * the losing writer's ops are still in the record afterwards. A refusal that
   * dropped them would be the same lost update the fence exists to stop, moved
   * one layer up.
   */
  it('keeps its ops when another writer wins the race to create the snapshot', async () => {
    const store = new FakeDocumentStore()
    const rival = await subject.fresh()
    subject.put(rival, 'rival', 'yes')
    store.beforeCompact = async () => {
      // Once: the rival's own save goes through this same method.
      store.beforeCompact = undefined
      await docsOver(store).save('ws-a', rival)
    }

    const doc = await subject.fresh()
    subject.put(doc, 'mine', 'yes')
    await docsOver(store).save('ws-a', doc)

    expect(store.refusals).toBe(1)
    const reopened = await docsOver(store).open('ws-a')
    expect(valueIn(reopened, 'rival')).toBe('yes')
    expect(valueIn(reopened, 'mine')).toBe('yes')
  })

  it('keeps its ops when another writer wins the race to fold the log', async () => {
    const store = new FakeDocumentStore()
    const docs = docsOver(store)
    const doc = await subject.fresh()
    subject.put(doc, 'title', 'first')
    await docs.save('ws-a', doc)

    // Past COMPACT_DELTA_BYTES, so the next save takes the FOLD branch rather
    // than the plain append — which is the branch under test, and the one a
    // smaller edit would silently skip.
    subject.put(doc, 'bulk', 'x'.repeat(80 * 1024))

    const rival = await subject.fresh()
    subject.kind.importInto(rival, store.docs.get('workspace-tree:ws-a')!.chunks[0]!.bytes)
    // The rival's own change has to be big enough to FOLD too. A small one
    // appends a delta and never touches the snapshot row, so the generation
    // would not move and this case would quietly exercise the ordinary path.
    subject.put(rival, 'rival', 'y'.repeat(80 * 1024))
    store.beforeCompact = async () => {
      store.beforeCompact = undefined
      await docsOver(store).save('ws-a', rival)
    }

    await docs.save('ws-a', doc)

    expect(store.refusals).toBe(1)
    const reopened = await docsOver(store).open('ws-a')
    expect((valueIn(reopened, 'rival') as string | undefined)?.length).toBe(80 * 1024)
    expect(valueIn(reopened, 'title')).toBe('first')
    expect((valueIn(reopened, 'bulk') as string | undefined)?.length).toBe(80 * 1024)
  })

  it('open() does not answer a stale document when a fold lands between its two reads', async () => {
    const store = new FakeDocumentStore()
    const docs = docsOver(store)
    const doc = await subject.fresh()
    subject.put(doc, 'title', 'first')
    await docs.save('ws-a', doc)
    // A small edit: appended to the log, never folded. It is ON DISK before
    // open() below begins, which is what makes losing it a stale read rather
    // than a race the reader could not have won.
    subject.put(doc, 'e1', 'kept')
    await docs.save('ws-a', doc)
    expect(store.docs.get('workspace-tree:ws-a')?.deltas).toHaveLength(1)

    // A rival whose edit is big enough to FOLD, armed to land exactly between
    // open()'s snapshot read and its log read. The fold absorbs e1 into the
    // new snapshot and empties the log — so a reader holding the OLD snapshot
    // and the NEW (empty) log has e1 nowhere. Loro does not throw on that: the
    // ops the log used to carry simply never arrive.
    const rival = await subject.fresh()
    subject.kind.importInto(rival, store.docs.get('workspace-tree:ws-a')!.chunks[0]!.bytes)
    for (const update of store.docs.get('workspace-tree:ws-a')!.deltas)
      subject.kind.importInto(rival, update)
    subject.put(rival, 'bulk', 'y'.repeat(80 * 1024))
    let folds = 0
    store.beforeLoadDeltas = async () => {
      store.beforeLoadDeltas = undefined
      await docsOver(store).save('ws-a', rival)
      folds += 1
    }

    const opened = await docs.open('ws-a')

    // The trigger fired, and the fold was a real one: generation moved and the
    // log is empty. Asserted so this cannot pass by the straddle never happening.
    expect(folds).toBe(1)
    expect(store.refusals).toBe(0)
    expect(store.docs.get('workspace-tree:ws-a')?.generation).toBe(2)
    expect(store.docs.get('workspace-tree:ws-a')?.deltas).toHaveLength(0)

    expect(valueIn(opened, 'title')).toBe('first')
    // The edit that was on disk before the read began.
    expect(valueIn(opened, 'e1')).toBe('kept')
    // And the fold's own edit, since the reader re-read past the generation move.
    expect((valueIn(opened, 'bulk') as string | undefined)?.length).toBe(80 * 1024)
  })

  /**
   * The shrunk counterexample from the multi-instance convergence property
   * (`mcp-server/src/server/store/multi-instance-convergence.test.ts`), pinned.
   *
   * The property is the generator that found it; these are the regression
   * guards. Both are shapes the generation fence does NOT cover — no writer
   * replaces another's snapshot, so every compare-and-swap here legitimately
   * succeeds and the record still loses an op.
   */
  it('a writer whose doc never read the record does not replace it with its own partial view', async () => {
    const store = new FakeDocumentStore()
    const docs = docsOver(store)

    const first = await subject.fresh()
    subject.put(first, 'first', '1')
    await docs.save('ws-a', first)

    // A second instance holding a doc that never opened this record — a process
    // whose cache is cold, which is the ordinary state of a second daemon.
    const second = await subject.fresh()
    // Big enough to take the FOLD branch: the append branch was never the
    // problem, and a small edit here would pass against the unfixed code.
    subject.put(second, 'second', 'y'.repeat(80 * 1024))
    await docs.save('ws-a', second)

    const reopened = await docs.open('ws-a')
    expect(valueIn(reopened, 'first')).toBe('1')
    expect((valueIn(reopened, 'second') as string | undefined)?.length).toBe(80 * 1024)
  })

  it('a fold does not supersede a delta its own doc never saw', async () => {
    const store = new FakeDocumentStore()
    const docs = docsOver(store)

    const seed = await subject.fresh()
    subject.put(seed, 'seed', '1')
    await docs.save('ws-a', seed)

    // Opened BEFORE the append below, so its doc is missing that op — the
    // ordinary consequence of two processes, not a contrived state.
    const stale = (await docs.open('ws-a'))!

    const other = (await docs.open('ws-a'))!
    subject.put(other, 'appended', '1')
    await docs.save('ws-a', other)

    // The stale instance now folds. Its superseded count covers the append it
    // cannot see, so an unfixed fold drops it.
    subject.put(stale, 'bulk', 'z'.repeat(80 * 1024))
    await docs.save('ws-a', stale)

    const reopened = await docs.open('ws-a')
    expect(valueIn(reopened, 'appended')).toBe('1')
    expect(valueIn(reopened, 'seed')).toBe('1')
  })

  /**
   * `catchUp`: the read half of multi-instance operation (ADR-0020 decision 5).
   *
   * `save` already lets several instances write without coordinating. Nothing
   * let a long-lived instance LEARN what the others wrote — its doc simply
   * stayed behind until something evicted it — so a second daemon served stale
   * reads indefinitely while converging perfectly in storage.
   */
  it('catches an instance up on another writer\u2019s appends, without reopening', async () => {
    const store = new FakeDocumentStore()
    const writer = docsOver(store)
    const seed = await subject.fresh()
    subject.put(seed, 'seed', '1')
    await writer.save('ws-a', seed)

    const reader = docsOver(store)
    const held = (await reader.open('ws-a'))!
    const cursor = await reader.readCursor('ws-a')

    const other = (await writer.open('ws-a'))!
    subject.put(other, 'added', '1')
    await writer.save('ws-a', other)

    expect(subject.get(held, 'added')).toBeUndefined()
    const { cursor: next } = await reader.catchUp('ws-a', held, cursor)
    expect(subject.get(held, 'added')).toBe('1')
    expect(subject.get(held, 'seed')).toBe('1')

    // Resuming from the answered cursor changes nothing further: a tail that
    // re-delivered its last batch would also pass the assertion above.
    const before = JSON.stringify(subject.entries(held))
    const { cursor: after } = await reader.catchUp('ws-a', held, next)
    expect(JSON.stringify(subject.entries(held))).toBe(before)
    expect(after.afterSeq).toBe(next.afterSeq)
  })

  it('reloads the snapshot when a fold moved the generation out from under the cursor', async () => {
    const store = new FakeDocumentStore()
    const writer = docsOver(store)
    const seed = await subject.fresh()
    subject.put(seed, 'seed', '1')
    await writer.save('ws-a', seed)

    const reader = docsOver(store)
    const held = (await reader.open('ws-a'))!
    const cursor = await reader.readCursor('ws-a')

    // Big enough to FOLD, so the log this cursor points into is superseded and
    // its seqs may be handed out again. Following the log alone from here
    // silently skips the folded ops.
    const other = (await writer.open('ws-a'))!
    subject.put(other, 'folded', 'w'.repeat(80 * 1024))
    await writer.save('ws-a', other)

    await reader.catchUp('ws-a', held, cursor)
    expect((subject.get(held, 'folded') as string | undefined)?.length).toBe(80 * 1024)
    expect(subject.get(held, 'seed')).toBe('1')
  })

  it('after a reload it still carries the deltas appended since the fold', async () => {
    const store = new FakeDocumentStore()
    const writer = docsOver(store)
    const seed = await subject.fresh()
    subject.put(seed, 'seed', '1')
    await writer.save('ws-a', seed)

    const reader = docsOver(store)
    const held = (await reader.open('ws-a'))!
    const cursor = await reader.readCursor('ws-a')

    // A fold, and then an ordinary append on top of it. The reload has to bring
    // BOTH — a reload that stopped at the snapshot would pass every assertion
    // in the case above, where the fold left the log empty.
    const other = (await writer.open('ws-a'))!
    subject.put(other, 'folded', 'w'.repeat(80 * 1024))
    await writer.save('ws-a', other)
    subject.put(other, 'after-fold', '1')
    await writer.save('ws-a', other)

    await reader.catchUp('ws-a', held, cursor)
    expect(subject.get(held, 'after-fold')).toBe('1')
    expect((subject.get(held, 'folded') as string | undefined)?.length).toBe(80 * 1024)
  })

  it('catchUp does not answer a stale document when a fold lands inside its reload', async () => {
    // The reload branch re-reads the snapshot and then the log, which is the
    // same two-call window open() has — and its own comment already names the
    // hazard ("a fold landing in between would leave the log half-applied")
    // while covering only the fold that landed BEFORE the snapshot read.
    const store = new FakeDocumentStore()
    const writer = docsOver(store)
    const seed = await subject.fresh()
    subject.put(seed, 'seed', '1')
    await writer.save('ws-a', seed)

    const reader = docsOver(store)
    const held = (await reader.open('ws-a'))!
    const cursor = await reader.readCursor('ws-a')

    // A fold moves the generation, so catchUp below takes the reload branch...
    const other = (await writer.open('ws-a'))!
    subject.put(other, 'bulk', 'x'.repeat(80 * 1024))
    await writer.save('ws-a', other)
    // ...and a small edit sits in the post-fold log, ON DISK before catchUp
    // begins. Losing it is a stale read, not a race the reader could not win.
    subject.put(other, 'e1', 'kept')
    await writer.save('ws-a', other)
    expect(store.docs.get('workspace-tree:ws-a')?.generation).toBe(2)
    expect(store.docs.get('workspace-tree:ws-a')?.deltas).toHaveLength(1)

    // Armed for the reload branch's log read — the SECOND loadDeltas of this
    // catchUp (the first is the tail read that notices the generation moved).
    // The rival folds e1 into a new snapshot and empties the log.
    const rival = (await writer.open('ws-a'))!
    subject.put(rival, 'bulk2', 'y'.repeat(80 * 1024))
    let reads = 0
    let folds = 0
    store.beforeLoadDeltas = async () => {
      reads += 1
      if (reads !== 2) return
      store.beforeLoadDeltas = undefined
      await writer.save('ws-a', rival)
      folds += 1
    }

    await reader.catchUp('ws-a', held, cursor)

    expect(folds).toBe(1)
    expect(store.refusals).toBe(0)
    expect(store.docs.get('workspace-tree:ws-a')?.generation).toBe(3)
    expect(store.docs.get('workspace-tree:ws-a')?.deltas).toHaveLength(0)

    expect(subject.get(held, 'seed')).toBe('1')
    expect((subject.get(held, 'bulk') as string | undefined)?.length).toBe(80 * 1024)
    // The edit that was on disk before the reload began.
    expect(subject.get(held, 'e1')).toBe('kept')
    expect((subject.get(held, 'bulk2') as string | undefined)?.length).toBe(80 * 1024)
  })

  it('keeps a caught-up instance able to write, with both sides surviving the save', async () => {
    const store = new FakeDocumentStore()
    const writer = docsOver(store)
    const seed = await subject.fresh()
    subject.put(seed, 'seed', '1')
    await writer.save('ws-a', seed)

    const reader = docsOver(store)
    const held = (await reader.open('ws-a'))!
    const cursor = await reader.readCursor('ws-a')
    subject.put(held, 'mine', '1')

    const other = (await writer.open('ws-a'))!
    subject.put(other, 'theirs', '1')
    await writer.save('ws-a', other)

    await reader.catchUp('ws-a', held, cursor)
    // The catch-up merged rather than replaced, so the unsaved local edit is
    // still there — and still SAVEABLE, which is the part that matters and the
    // part an in-place import alone does not demonstrate.
    await reader.save('ws-a', held)

    const settled = (await writer.open('ws-a'))!
    expect(subject.get(settled, 'mine')).toBe('1')
    expect(subject.get(settled, 'theirs')).toBe('1')
    expect(subject.get(settled, 'seed')).toBe('1')
  })

  /**
   * The bytes a catch-up answers are what the daemon's websocket fan-out sends
   * on, so a peer importing them has to arrive at the same place. Nothing else
   * checks the RETURN value — the cases above all assert on the doc that was
   * caught up, which is mutated in place and would pass against a `catchUp`
   * that answered an empty array.
   */
  it('answers bytes that bring an unrelated peer to the same state', async () => {
    const store = new FakeDocumentStore()
    const writer = docsOver(store)
    const seed = await subject.fresh()
    subject.put(seed, 'seed', '1')
    await writer.save('ws-a', seed)

    const reader = docsOver(store)
    const held = (await reader.open('ws-a'))!
    const cursor = await reader.readCursor('ws-a')
    // A peer that is level with the reader — the connected browser's copy.
    const peer = await subject.fresh()
    subject.kind.importInto(peer, subject.kind.exportSnapshot(held))

    const other = (await writer.open('ws-a'))!
    subject.put(other, 'appended', '1')
    await writer.save('ws-a', other)

    const { updates } = await reader.catchUp('ws-a', held, cursor)
    expect(updates.length).toBeGreaterThan(0)
    for (const update of updates) subject.kind.importInto(peer, update)
    expect(subject.entries(peer)).toEqual(subject.entries(held))
  })

  it('answers bytes a peer can use across a fold, where the tail alone is not enough', async () => {
    const store = new FakeDocumentStore()
    const writer = docsOver(store)
    const seed = await subject.fresh()
    subject.put(seed, 'seed', '1')
    await writer.save('ws-a', seed)

    const reader = docsOver(store)
    const held = (await reader.open('ws-a'))!
    const cursor = await reader.readCursor('ws-a')
    const peer = await subject.fresh()
    subject.kind.importInto(peer, subject.kind.exportSnapshot(held))

    const other = (await writer.open('ws-a'))!
    subject.put(other, 'folded', 'w'.repeat(80 * 1024))
    await writer.save('ws-a', other)

    const { updates } = await reader.catchUp('ws-a', held, cursor)
    for (const update of updates) subject.kind.importInto(peer, update)
    expect(subject.entries(peer)).toEqual(subject.entries(held))
  })

  /**
   * `readCursor` asks where the record STANDS, and must not drag the record
   * back with it.
   *
   * It is called on every baseline pass of the daemon's tail and before every
   * GC pass, so paying for the whole delta log each time is a cost nobody asked
   * for. White-box on purpose: the answer is identical either way, so nothing
   * observable from outside this class can tell the two apart — which is
   * exactly the shape of cost that creeps back in unnoticed.
   */
  it('reads the cursor without fetching the log behind it', async () => {
    const store = new FakeDocumentStore()
    const docs = docsOver(store)
    const doc = await subject.fresh()
    subject.put(doc, 'seed', '1')
    await docs.save('ws-a', doc)
    subject.put(doc, 'more', '1')
    await docs.save('ws-a', doc)

    const asked: (number | null)[] = []
    const spied = vi.spyOn(store, 'loadDeltas')
    spied.mockImplementation(async (input) => {
      asked.push(input.afterSeq)
      return store.loadDeltasReal(input)
    })
    const cursor = await docs.readCursor('ws-a')
    spied.mockRestore()

    expect(asked).toHaveLength(1)
    expect(asked[0]).not.toBeNull()
    // And it is still the real position: a cursor that answered null would
    // make the tail replay the whole log on its next pass.
    expect(cursor.afterSeq).not.toBeNull()
    expect(cursor.generation).not.toBeNull()
  })
})
