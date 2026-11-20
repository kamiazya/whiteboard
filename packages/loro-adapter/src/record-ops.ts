import type { documentEngine as wire } from '@kamiazya/whiteboard-model'
import type { AnswerShape } from './engine/read-value.js'
import type { RemovedDocument } from './removed-documents.js'

/** What a record stands at, in the encodings a keeper compares and stores. */
export interface RecordVersion {
  /** The version vector in the engine's encoding. */
  readonly encoded: Uint8Array
  /** The frontiers in the engine's encoding: what a keeper stores to name this point. */
  readonly encodedFrontiers: Uint8Array
  /** The version vector as peer and counter, which is what a since-read is asked with. */
  readonly entries: readonly wire.VersionEntry[]
}

/**
 * What an operation does with a workspace record it holds: named reads, named
 * writes, a judged import, and past views. Written once over this seam, an
 * operation runs over a `LoroDoc` or an engine lease without learning which,
 * so a record's holder changes without the operation changing.
 *
 * The two kinds differ in one place and the contract names it: after a
 * REFUSED judged import a `LoroDoc` holds the operations it refused, so the
 * caller drops the record, as every operation already does; a lease holds
 * nothing of them, and dropping it is merely unnecessary.
 *
 * ponytail: the `LoroDoc` implementation goes with `loroDocKind`.
 */
export interface RecordOps<R> {
  read<T>(record: R, query: wire.Query, shape: AnswerShape<T>): Promise<T>
  /** Applies the batch as one change, unjudged: the keeper judges what it is pushed. */
  write(record: R, batch: wire.Write[]): wire.MutationApplied
  importJudged(record: R, bytes: Uint8Array, judge: wire.ImportJudge): wire.MutationResult
  versionOf(record: R): RecordVersion
  /**
   * What the record held at `frontiers`: the operations that point had seen,
   * without moving a view to it. Throws for bytes that are no frontiers and
   * for a point the record does not hold.
   */
  versionAt(record: R, frontiers: Uint8Array): RecordVersion
  /**
   * The documents the operations after `since` took out of the record, as a
   * trash keeps them: deepest first, a document below another removed one in
   * that one's bytes, survivors cut out of every export. Nothing for
   * operations that removed nothing.
   */
  removedSince(record: R, since: readonly wire.VersionEntry[]): RemovedDocument[]
  /** A read-only copy of the record as it stood at `frontiers`; the caller releases it with its kind. */
  viewAt(record: R, frontiers: Uint8Array): R
  moveView(view: R, frontiers: Uint8Array): void
  /** One document as a document of its own, or `null` when the record holds none. */
  exportProjection(record: R, documentId: string): Uint8Array | null
  /** The whole record, as a snapshot another replica opens. */
  exportSnapshot(record: R): Uint8Array
  /**
   * The operations after a stored version vector (`RecordVersion.encoded`), or
   * the whole history for `null`. Importing them into a record that stood at
   * that version brings it to this one.
   */
  exportUpdateSince(record: R, since: Uint8Array | null): Uint8Array
  /**
   * The record as a shallow snapshot cut at `version`, a version vector as
   * `versionAt` answers one. The history before the cut is dropped.
   */
  exportShallowSnapshotAt(record: R, version: readonly wire.VersionEntry[]): Uint8Array
  /** The operations the record's history starts from, as a version vector; empty unless it was cut. */
  shallowRootVersion(record: R): wire.VersionEntry[]
  /** Gives back a record a view made; a `LoroDoc` needs nothing and a lease frees its handle. */
  release(record: R): void
}

/**
 * A read-only copy of a record as it stood at a point, bound to its operations
 * like a session. The caller releases it; a caller that reads many points moves
 * one view with `moveTo`, because making one copies the whole record.
 */
export interface RecordView {
  read<T>(query: wire.Query, shape: AnswerShape<T>): Promise<T>
  /** One document as a document of its own, or `null` when the view holds none. */
  exportProjection(documentId: string): Uint8Array | null
  moveTo(frontiers: Uint8Array): void
  release(): void
}

/**
 * One record bound to the operations that read and write it and to the save
 * that persists it, with the holder's own type hidden. A caller that must stay
 * ignorant of whether the record is a `LoroDoc` or a lease (an operation in
 * `server-core`, which sees the daemon only through its seams) holds this.
 */
export interface RecordSession {
  version(): RecordVersion
  /** What the record held at `frontiers`; throws for a point it does not hold. */
  versionAt(frontiers: Uint8Array): RecordVersion
  importJudged(bytes: Uint8Array, judge: wire.ImportJudge): wire.MutationResult
  read<T>(query: wire.Query, shape: AnswerShape<T>): Promise<T>
  write(batch: wire.Write[]): wire.MutationApplied
  removedSince(since: readonly wire.VersionEntry[]): RemovedDocument[]
  /** The record as it stood at `frontiers` (bytes `version().encodedFrontiers` answered). */
  view(frontiers: Uint8Array): RecordView
  /** The whole record as a snapshot another replica opens. */
  exportSnapshot(): Uint8Array
  /** The operations after a version vector `version().encoded` answered; all of them for `null`. */
  exportUpdateSince(since: Uint8Array | null): Uint8Array
  /** One document as a document of its own, or `null` when the record holds none. */
  exportProjection(documentId: string): Uint8Array | null
  /** The record cut at a version vector, history before it dropped (compaction). */
  exportShallowSnapshotAt(version: readonly wire.VersionEntry[]): Uint8Array
  /** The operations the record's history starts from, as a version vector. */
  shallowRootVersion(): wire.VersionEntry[]
  /** Persists what the session changed, announcing it as every save does. */
  save(): Promise<void>
}

/** Binds `record` to `ops` and the `save` that persists it. */
export function bindRecordOps<R>(
  ops: RecordOps<R>,
  record: R,
  save: (record: R) => Promise<void>,
): RecordSession {
  return {
    version: () => ops.versionOf(record),
    versionAt: (frontiers) => ops.versionAt(record, frontiers),
    importJudged: (bytes, judge) => ops.importJudged(record, bytes, judge),
    read: (query, shape) => ops.read(record, query, shape),
    write: (batch) => ops.write(record, batch),
    removedSince: (since) => ops.removedSince(record, since),
    view(frontiers) {
      const past = ops.viewAt(record, frontiers)
      return {
        read: (query, shape) => ops.read(past, query, shape),
        exportProjection: (documentId) => ops.exportProjection(past, documentId),
        moveTo: (point) => ops.moveView(past, point),
        release: () => ops.release(past),
      }
    },
    exportSnapshot: () => ops.exportSnapshot(record),
    exportUpdateSince: (since) => ops.exportUpdateSince(record, since),
    exportProjection: (documentId) => ops.exportProjection(record, documentId),
    exportShallowSnapshotAt: (version) => ops.exportShallowSnapshotAt(record, version),
    shallowRootVersion: () => ops.shallowRootVersion(record),
    save: () => save(record),
  }
}
