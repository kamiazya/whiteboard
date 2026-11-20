/** How a record's operations relate to a stored version vector: what each side holds the other lacks. */
export type VersionOrder =
  /** The same operations. */
  | 'equal'
  /** The record holds only operations the stored version has, and lacks some of them. */
  | 'behind'
  /** The record holds every operation the stored version names, and more. */
  | 'ahead'
  /** Each holds operations the other lacks. */
  | 'concurrent'

/**
 * What a keeper needs of a record to store it: load it from the bytes a store
 * holds, say what version it stands at, and export what a store writes.
 *
 * A keeper is written once over this seam so the record it holds can be a
 * `LoroDoc` or an engine lease without the keeper learning which. Everything
 * but `load` and `empty` is synchronous because a record that exists already
 * carries its engine.
 */
export interface RecordKind<R> {
  /**
   * The record the snapshot and the updates after it describe. Throws
   * `RecordBytesRejectedError` when the bytes are not a document.
   */
  load(snapshot: Uint8Array, updates: readonly Uint8Array[]): Promise<R>
  /** A record with no operations, writing as a peer of its own. */
  empty(): Promise<R>
  /** Merges bytes another replica exported. */
  importInto(record: R, bytes: Uint8Array): void
  /** The record's version vector in the encoding a store keeps as its frontier. */
  encodedVersion(record: R): Uint8Array<ArrayBuffer>
  /** Whether the record holds exactly the operations a stored version vector names. */
  atVersion(record: R, stored: Uint8Array): boolean
  /** How the record's operations relate to a stored version vector's. */
  compareVersion(record: R, stored: Uint8Array): VersionOrder
  /** The operations after a stored version vector; the whole history for `null`. */
  exportUpdateSince(record: R, stored: Uint8Array | null): Uint8Array
  exportSnapshot(record: R): Uint8Array
  /** Gives the record back once its holder is done with it. */
  release(record: R): void
}

/** A kind's refusal of bytes that came out of a store and are not a document. */
export class RecordBytesRejectedError extends Error {
  constructor(cause: unknown) {
    super(String(cause), { cause })
    this.name = 'RecordBytesRejectedError'
  }
}
