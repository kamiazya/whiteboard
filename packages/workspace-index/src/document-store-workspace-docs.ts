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
import type {
  DeltaSeq,
  DocRef,
  DocumentStore,
  SnapshotGeneration,
} from '@kamiazya/whiteboard-ports'
import {
  chunkSnapshot,
  reassembleSnapshot,
  StoredDocumentUnreadableError,
  shouldCompact,
} from '@kamiazya/whiteboard-ports'
import { LoroDoc, VersionVector } from 'loro-crdt'
import type { CaughtUp, WorkspaceDocCursor, WorkspaceDocs } from './workspace-docs.js'

const MAX_CHUNK_BYTES = 1_000_000
/** How many times `readRecord` will re-read past a fold that landed mid-read. */
const READ_ATTEMPTS = 3

function refOf(workspaceId: string): DocRef {
  return { kind: 'workspace-tree', workspaceId }
}

/**
 * Import bytes that came OUT of the record, and say so when the CRDT refuses
 * them.
 *
 * `open` can fail two ways and a caller has to tell them apart before it can
 * say anything true to a person: the store did not answer (a transaction
 * aborted, a connection blocked behind another tab), or the bytes it DID
 * answer are not a document. Only this layer knows both halves at once —
 * that these bytes are the record, and that loro-crdt rejected them — so the
 * typing belongs here rather than at any call site.
 *
 * Untyped, the second arrived as whatever loro threw ("Decode error: (Invalid
 * import data)") and was indistinguishable from the first, which is how
 * `apps/web` came to classify every failed read as damage and show a healthy
 * document behind "This canvas’s data could not be read."
 */
function importStored(doc: LoroDoc, bytes: Uint8Array, workspaceId: string): void {
  try {
    doc.import(bytes)
  } catch (cause) {
    throw new StoredDocumentUnreadableError(
      'malformed',
      `stored workspace document ${workspaceId} could not be imported: ${String(cause)}`,
    )
  }
}

export class DocumentStoreWorkspaceDocs implements WorkspaceDocs {
  constructor(private readonly store: DocumentStore) {}

  async open(workspaceId: string): Promise<LoroDoc | null> {
    const record = await this.readRecord(refOf(workspaceId))
    if (record === null) return null
    const doc = new LoroDoc()
    importStored(doc, record.snapshot, workspaceId)
    for (const update of record.updates) importStored(doc, update, workspaceId)
    return doc
  }

  /**
   * The record as ONE consistent read: a snapshot and the log that belongs
   * to it, or `null` when there is no snapshot.
   *
   * The store answers the two in separate calls, and a fold committed between
   * them hands back the OLD snapshot with the NEW log — entries that depend on
   * ops only the new snapshot holds. Loro does not refuse those; it parks them
   * pending, and the document opens without whatever the fold absorbed.
   * Measured against the store double: an edit on disk before the read began,
   * absent from what the read returned, and nothing red anywhere.
   *
   * The manifest's generation is read FIRST and compared with the one the log
   * reports, so the snapshot read sits inside a span whose two ends agree —
   * and generations only increase, so agreeing ends mean no fold landed
   * between them. A mismatch retries the whole read.
   *
   * ponytail: bounded at three attempts, after which the last read is answered
   * as-is. A fold happens once per COMPACT_DELTA_BYTES written, so one inside
   * the span is rare and two are not a case a fourth read would settle.
   */
  private async readRecord(docRef: ReturnType<typeof refOf>): Promise<{
    snapshot: Uint8Array
    updates: Uint8Array[]
    generation: SnapshotGeneration | null
    lastSeq: DeltaSeq | null
  } | null> {
    for (let attempt = 1; ; attempt += 1) {
      const header = await this.store.readSnapshotManifest({ docRef })
      if (header === null) return null
      const stored = await this.store.loadSnapshot({ docRef })
      if (stored === null) return null
      const tail = await this.store.loadDeltas({ docRef, afterSeq: null })
      if (tail.generation === header.generation || attempt === READ_ATTEMPTS) {
        return {
          snapshot: reassembleSnapshot(stored.manifest, stored.chunks),
          updates: tail.updates,
          generation: tail.generation,
          lastSeq: tail.lastSeq,
        }
      }
    }
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
      // The cursor, not the payload. `lastSeq` reports the whole log's
      // highest seq whatever was RETURNED — the contract says so precisely
      // for this caller — so asking from past the end answers the position
      // and no bytes. `null` here would mean "give me everything", which is
      // the opposite of what this method is for, and it is called on every
      // baseline pass of the tail and before every GC pass.
      afterSeq: Number.MAX_SAFE_INTEGER,
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
    // One consistent read of snapshot and log, rather than one call each: the
    // fold this branch exists to follow can land AGAIN between those two
    // calls, and this branch used to cover only the one that landed before
    // it. `readRecord` is what closes that.
    const record = await this.readRecord(docRef)
    if (record === null) {
      // The record is gone (deleted while catching up): nothing to carry, and
      // the cursor says what a log with no snapshot reports.
      return { cursor: { generation: null, afterSeq: null }, updates: [] }
    }
    doc.import(record.snapshot)
    for (const update of record.updates) doc.import(update)
    return {
      cursor: { generation: record.generation, afterSeq: record.lastSeq },
      updates: [record.snapshot, ...record.updates],
    }
  }
}
