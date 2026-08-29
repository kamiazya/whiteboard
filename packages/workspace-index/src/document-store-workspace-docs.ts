/**
 * `WorkspaceDocs` over any `DocumentStore` — which is to say, over both
 * keepers.
 *
 * No new storage anywhere. `docRefKey({ kind: 'workspace-tree', workspaceId })`
 * keys into the same store every document already uses, and every
 * implementation passes the port's conformance for tree refs; the workspace
 * document is just another record, chunk-split and delta-logged like the rest.
 *
 * Written once because the browser version turned out to call nothing but
 * port methods — a second copy against libSQL would have differed in the
 * constructor argument and nothing else.
 */
import type { DocRef, DocumentStore } from '@kamiazya/whiteboard-ports'
import { chunkSnapshot, reassembleSnapshot, shouldCompact } from '@kamiazya/whiteboard-ports'
import { LoroDoc, VersionVector } from 'loro-crdt'
import type { CaughtUp, WorkspaceDocCursor, WorkspaceDocs } from './workspace-docs.js'

const MAX_CHUNK_BYTES = 1_000_000

function refOf(workspaceId: string): DocRef {
  return { kind: 'workspace-tree', workspaceId }
}

export class DocumentStoreWorkspaceDocs implements WorkspaceDocs {
  constructor(private readonly store: DocumentStore) {}

  async open(workspaceId: string): Promise<LoroDoc | null> {
    const docRef = refOf(workspaceId)
    const stored = await this.store.loadSnapshot({ docRef })
    if (stored === null) return null
    const doc = new LoroDoc()
    doc.import(reassembleSnapshot(stored.manifest, stored.chunks))
    const { updates } = await this.store.loadDeltas({ docRef, afterSeq: null })
    for (const update of updates) doc.import(update)
    return doc
  }

  async create(workspaceId: string): Promise<LoroDoc> {
    const existing = await this.open(workspaceId)
    if (existing !== null) return existing
    const doc = new LoroDoc()
    await this.save(workspaceId, doc)
    return doc
  }

  /**
   * The incremental shape both keepers converged on: append the delta since
   * the stored frontier, fold into a fresh snapshot once the log passes the
   * shared budget, and never write when nothing changed.
   *
   * Answers the update bytes it persisted — what a sync fan-out hands to the
   * workspace's other subscribers — and `null` when nothing was written.
   * Returned here rather than re-derived by the caller because only this
   * method knows the frontier the store held BEFORE the write; exporting
   * "since the stored frontier" afterwards yields an empty envelope.
   */
  async save(workspaceId: string, doc: LoroDoc): Promise<Uint8Array | null> {
    const docRef = refOf(workspaceId)
    const header = await this.store.readSnapshotManifest({ docRef })
    if (header === null) {
      const snapshot = doc.export({ mode: 'snapshot' })
      const { manifest: fresh, chunks } = chunkSnapshot(new Uint8Array(snapshot), MAX_CHUNK_BYTES)
      // The whole history as one update: what an empty peer needs, and also
      // what this call appends if it loses the race below.
      const update = new Uint8Array(doc.export({ mode: 'update' }))
      const created = await this.store.saveCompactedSnapshot({
        docRef,
        manifest: fresh,
        chunks,
        frontier: new Uint8Array(doc.oplogVersion().encode()),
        // Nothing to supersede: there is no log this snapshot folded.
        supersededDeltaCount: 0,
        expectedGeneration: null,
      })
      if (created.ok) return update
      // Another writer minted the snapshot between the read and the write.
      // Theirs does not contain these ops, so appending is the only move that
      // keeps both — replacing it would be the lost update this fence exists
      // to stop (ADR-0020).
      await this.appendInstead(docRef, doc, update)
      return update
    }

    const stored = await this.store.readFrontier({ docRef })
    if (stored === null) return null
    // A VERSION comparison, not a byte count: an update carrying no ops is
    // still 22 bytes of envelope, so an idle save would grow the log forever.
    const comparison = doc.oplogVersion().compare(VersionVector.decode(stored.frontier))
    if (comparison === 0) return null

    const update = new Uint8Array(
      doc.export({ mode: 'update', from: VersionVector.decode(stored.frontier) }),
    )
    const { updates: existing } = await this.store.loadDeltas({
      docRef,
      afterSeq: null,
    })
    if (shouldCompact([...existing, update])) {
      // Folded from the STORED state plus this update — never from `doc`.
      //
      // `doc` is one writer's view, and a writer's view is not the record: it
      // holds whatever that instance had when it last read, plus its own
      // edits. Exporting a snapshot from it replaces the record with a subset
      // of itself, dropping every op this instance never saw. The generation
      // fence does not catch that — nobody REPLACED the snapshot, so the
      // compare-and-swap legitimately succeeds — and neither does the
      // superseded count, which drops a prefix this snapshot does not
      // contain. Found by the multi-instance convergence property, not by
      // any example test.
      //
      // The stored bytes are read only here, on the path that already decided
      // to fold — once per COMPACT_DELTA_BYTES written, not once per save.
      // `loro-store.ts` folds the same way in the browser, and for the same
      // reason.
      const base = await this.store.loadSnapshot({ docRef })
      const merged = new LoroDoc()
      if (base !== null) merged.import(reassembleSnapshot(base.manifest, base.chunks))
      for (const stale of existing) merged.import(stale)
      merged.import(update)
      const snapshot = merged.export({ mode: 'snapshot' })
      const { manifest: fresh, chunks } = chunkSnapshot(new Uint8Array(snapshot), MAX_CHUNK_BYTES)
      const folded = await this.store.saveCompactedSnapshot({
        docRef,
        manifest: fresh,
        chunks,
        // The MERGED version, not `doc`'s: the snapshot being written holds
        // every op above, so reporting the writer's own narrower vector would
        // under-claim the record's state.
        frontier: new Uint8Array(merged.oplogVersion().encode()),
        supersededDeltaCount: existing.length,
        expectedGeneration: header.generation,
      })
      if (folded.ok) return update
      // Refused: someone else folded first, and this doc's new ops are in the
      // snapshot we did NOT write. Appending them is what makes losing the
      // race cost a delay rather than an edit — the whole reason the refusal
      // is an outcome and not an error.
      await this.appendInstead(docRef, doc, update)
      return update
    }
    await this.store.appendDeltas({
      docRef,
      deltaBatch: {
        updates: [update],
        newFrontier: new Uint8Array(doc.oplogVersion().encode()),
      },
    })
    return update
  }

  /**
   * The one move available after a refused fold: put the ops in the log
   * instead of the snapshot.
   *
   * Not merged with the plain append path above because the reason differs
   * and the reason is the whole point — this one runs having just decided not
   * to overwrite another writer's snapshot.
   */
  private async appendInstead(docRef: DocRef, doc: LoroDoc, update: Uint8Array): Promise<void> {
    await this.store.appendDeltas({
      docRef,
      deltaBatch: {
        updates: [new Uint8Array(update)],
        newFrontier: new Uint8Array(doc.oplogVersion().encode()),
      },
    })
  }

  async readCursor(workspaceId: string): Promise<WorkspaceDocCursor> {
    const { lastSeq, generation } = await this.store.loadDeltas({
      docRef: refOf(workspaceId),
      // The cursor, not the payload: this asks where the record stands, and
      // the updates it drags along are the caller's own current state.
      afterSeq: null,
    })
    return { generation, afterSeq: lastSeq }
  }

  async catchUp(workspaceId: string, doc: LoroDoc, cursor: WorkspaceDocCursor): Promise<CaughtUp> {
    const docRef = refOf(workspaceId)
    const tail = await this.store.loadDeltas({ docRef, afterSeq: cursor.afterSeq })
    if (tail.generation === cursor.generation) {
      // Same generation, so the seqs this cursor points past are still the
      // ones it consumed: the tail alone is the whole difference.
      for (const update of tail.updates) doc.import(update)
      return {
        cursor: { generation: tail.generation, afterSeq: tail.lastSeq ?? cursor.afterSeq },
        updates: tail.updates,
      }
    }
    // The generation moved, so a fold has superseded some prefix of the log —
    // possibly all of it, after which the next append starts numbering again.
    // Following the log from here would skip whatever was folded into the
    // snapshot AND could mistake reused seqs for ones already seen, so the
    // snapshot is re-read. Importing it is a MERGE, which is why `doc`'s own
    // unsaved edits survive.
    const base = await this.store.loadSnapshot({ docRef })
    const carried: Uint8Array[] = []
    if (base !== null) {
      const snapshot = reassembleSnapshot(base.manifest, base.chunks)
      doc.import(snapshot)
      carried.push(snapshot)
    }
    // Re-read rather than reusing `tail`: the snapshot above was read after
    // it, so a fold landing in between would leave the log half-applied.
    const settled = await this.store.loadDeltas({ docRef, afterSeq: null })
    for (const update of settled.updates) doc.import(update)
    carried.push(...settled.updates)
    return {
      cursor: { generation: settled.generation, afterSeq: settled.lastSeq },
      updates: carried,
    }
  }
}
