import type { LegacyRecord, RecordLease } from '@kamiazya/whiteboard-loro-adapter'

/**
 * A position in a workspace record, as a tailing reader holds it.
 *
 * The PAIR, not the seq alone (ADR-0020 decision 5). `appendDeltas` assigns
 * from the highest seq present, so a fold that empties the log lets the next
 * append reuse seqs this reader has already consumed; the generation is what
 * says the prefix is gone and the snapshot has to be re-read.
 */
export interface WorkspaceDocCursor {
  generation: number | null
  afterSeq: number | null
}

/**
 * What a catch-up brought in, and where to resume.
 *
 * `updates` is returned rather than merely applied because a caller that
 * catches a SHARED document up usually has an audience for it — the daemon's
 * SSE fan-out sends these bytes on to every connected client, which is
 * how a browser attached to one instance learns what another instance wrote.
 * Deriving them again from the doc afterwards is not possible: only the
 * catch-up knows which ops were new.
 *
 * On a reload `updates` carries the snapshot and the log that survived the
 * fold rather than a delta. Both are bytes `import` accepts and both are
 * idempotent, so a recipient converges either way and does not have to know
 * which case it received.
 */
export interface CaughtUp {
  cursor: WorkspaceDocCursor
  updates: readonly Uint8Array[]
}

/**
 * Where a workspace's Loro document comes from, and where a change to it goes.
 *
 * The one thing this package does not decide. A workspace document is bytes in
 * a store — libSQL in the daemon, IndexedDB in the browser — and both roots
 * already own that machinery; what neither should own is a second copy of the
 * index rules on top of it.
 *
 * `save` exists rather than the index writing through the document itself
 * because Loro commits into memory: nothing reaches a store until somebody
 * exports and writes. Making that a step the seam names keeps a caller from
 * assuming a mutation persisted when it only converged locally.
 *
 * `R` is what holds the record in memory. It defaults to the `LoroDoc` every
 * consumer still takes, and is the engine lease for those that have moved.
 * ponytail: the default goes when the last consumer holds a lease.
 */
export interface WorkspaceDocs<R = LegacyRecord> {
  /**
   * The workspace's document, or `null` when it does not exist.
   *
   * `null` rather than an empty document, because "no such workspace" is an
   * error the port has to raise and an empty workspace is not.
   */
  open(workspaceId: string): Promise<R | null>
  /**
   * Creates the workspace's document, or answers the existing one.
   *
   * Idempotent, matching `createWorkspace`: a caller that wants the workspace
   * to be there is served either way.
   */
  create(workspaceId: string): Promise<R>
  /**
   * Persists whatever the index just changed, answering the update bytes it
   * wrote — what a sync fan-out hands to the workspace's other subscribers —
   * or `null` when nothing changed. Returned from here rather than derived by
   * the caller because only the save knows the frontier the store held BEFORE
   * the write.
   */
  save(workspaceId: string, doc: R): Promise<Uint8Array | null>
  /**
   * Where the record stands right now, for a caller that has just opened it
   * and wants to follow along from here.
   */
  readCursor(workspaceId: string): Promise<WorkspaceDocCursor>
  /**
   * Imports everything the record has gained since `cursor` into `doc`, and
   * answers the position to resume from.
   *
   * The read half of multi-instance operation. `save` already lets several
   * instances write without coordinating; without this, a long-lived instance
   * never LEARNS what the others wrote — its doc stays behind until something
   * evicts it, so it serves stale reads indefinitely while storage converges
   * perfectly underneath.
   *
   * Merges rather than replaces: `doc` may carry local edits that are not
   * saved yet, and a catch-up must not be a way to lose them.
   */
  catchUp(workspaceId: string, doc: R, cursor: WorkspaceDocCursor): Promise<CaughtUp>
  /**
   * The version vector the store holds for the record, or `null` when it holds
   * none. One store read and no snapshot, for a caller that wants to know
   * whether its copy is behind before it pays to open one.
   */
  storedVersion(workspaceId: string): Promise<Uint8Array | null>
}

/** A workspace record held as an engine lease: the caller releases what it opens. */
export type WorkspaceRecords = WorkspaceDocs<RecordLease>
