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
  /** `read` answered at once, for every query but `fileReferences`, which asks the keeper. */
  readNow<T>(record: R, query: wire.Query, shape: AnswerShape<T>): T
  /** Applies the batch as one change, unjudged: the keeper judges what it is pushed. */
  write(record: R, batch: wire.Write[]): wire.MutationApplied
  importJudged(record: R, bytes: Uint8Array, judge: wire.ImportJudge): wire.MutationResult
  versionOf(record: R): RecordVersion
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
}

/**
 * One record bound to the operations that read and write it and to the save
 * that persists it, with the holder's own type hidden. A caller that must stay
 * ignorant of whether the record is a `LoroDoc` or a lease (an operation in
 * `server-core`, which sees the daemon only through its seams) holds this.
 */
export interface RecordSession {
  version(): RecordVersion
  importJudged(bytes: Uint8Array, judge: wire.ImportJudge): wire.MutationResult
  read<T>(query: wire.Query, shape: AnswerShape<T>): Promise<T>
  readNow<T>(query: wire.Query, shape: AnswerShape<T>): T
  write(batch: wire.Write[]): wire.MutationApplied
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
    importJudged: (bytes, judge) => ops.importJudged(record, bytes, judge),
    read: (query, shape) => ops.read(record, query, shape),
    readNow: (query, shape) => ops.readNow(record, query, shape),
    write: (batch) => ops.write(record, batch),
    save: () => save(record),
  }
}
