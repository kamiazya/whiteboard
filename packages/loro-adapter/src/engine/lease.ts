/**
 * What a host holds to use one engine document, and the calls it makes through
 * it. A lease is an engine, a handle on it and the right to give the handle
 * back, so code that works on a document does not care whether it opened the
 * document or borrowed it from a cache that outlives the call.
 *
 * The kit below takes and answers bytes as `Uint8Array`: the contract spells
 * bytes as base64 text, which is the engine's wire and not a host's concern.
 */
import {
  base64ToBytes,
  bytesToBase64,
  type documentEngine as wire,
} from '@kamiazya/whiteboard-model'
import type { RemovedDocument } from '../removed-documents.js'
import { exportedBytes } from './answers.js'
import { randomPeerId } from './peer.js'
import { type AnswerShape, readValue, unwrapAnswer } from './read-value.js'
import type { CrdtEngine } from './types.js'

export interface RecordLease {
  readonly engine: CrdtEngine
  readonly handle: wire.Handle
  /**
   * Gives the document back. Releasing twice is one release, and a handle the
   * engine no longer holds (it was re-instantiated after a trap) is nothing to
   * give back, so neither throws.
   */
  release(): void
}

/** A lease over a handle its holder opened: releasing it closes the handle. */
export function ownedLease(engine: CrdtEngine, handle: wire.Handle): RecordLease {
  let released = false
  return {
    engine,
    handle,
    release() {
      if (released) return
      released = true
      try {
        engine.close({ handle })
      } catch {
        // The engine holds no such handle, which is what releasing was for.
      }
    },
  }
}

/** Runs `fn` on the lease and releases it whether `fn` returns, rejects or throws. */
export async function withLease<T>(
  lease: RecordLease,
  fn: (lease: RecordLease) => T | Promise<T>,
): Promise<T> {
  try {
    return await fn(lease)
  } finally {
    lease.release()
  }
}

function bytesOf(encoded: string): Uint8Array {
  const bytes = base64ToBytes(encoded)
  if (bytes === null) throw new TypeError('the engine answered bytes that are not base64')
  return bytes
}

/** What a document holds, as versions a host compares and as the bytes a keeper stores. */
export interface LeaseVersion {
  /** The version vector in the engine's encoding. */
  readonly encoded: Uint8Array
  /** The frontiers in the engine's encoding: what a keeper stores to name this point. */
  readonly encodedFrontiers: Uint8Array
  readonly entries: wire.VersionEntry[]
  readonly frontiers: wire.VersionEntry[]
}

function leaseVersion(answer: wire.VersionResponse): LeaseVersion {
  return {
    encoded: bytesOf(answer.encodedVersion),
    encodedFrontiers: bytesOf(answer.encodedFrontiers),
    entries: answer.version,
    frontiers: answer.frontiers,
  }
}

export function versionOf(lease: RecordLease): LeaseVersion {
  return leaseVersion(lease.engine.version({ handle: lease.handle }))
}

function entriesOfFrontiers(lease: RecordLease, frontiers: Uint8Array): wire.VersionEntry[] {
  return lease.engine.decode({ kind: 'frontiers', bytes: bytesToBase64(frontiers) }).entries
}

/**
 * What the record held at `frontiers` (bytes `versionOf` answered): the
 * operations that point had seen. Throws for bytes that are no frontiers and
 * for a point the record does not hold.
 */
export function versionAt(lease: RecordLease, frontiers: Uint8Array): LeaseVersion {
  return leaseVersion(
    lease.engine.version({ handle: lease.handle, at: entriesOfFrontiers(lease, frontiers) }),
  )
}

/**
 * A read-only view of the record as it stood at `frontiers` (the bytes
 * `versionOf` answered when the point was taken). The view is a copy the caller
 * releases; a caller that reads many points moves one view with `moveView`,
 * because making one copies the whole record.
 */
export function viewAt(lease: RecordLease, frontiers: Uint8Array): RecordLease {
  const { engine } = lease
  const at = entriesOfFrontiers(lease, frontiers)
  return ownedLease(engine, engine.fork({ handle: lease.handle, peer: randomPeerId(), at }).handle)
}

/** Moves a view `viewAt` made to another point of the record's history. */
export function moveView(view: RecordLease, frontiers: Uint8Array): void {
  view.engine.checkout({ handle: view.handle, at: entriesOfFrontiers(view, frontiers) })
}

export function exportSnapshot(lease: RecordLease): Uint8Array {
  return bytesOf(exportedBytes(lease.engine.export({ handle: lease.handle, mode: 'snapshot' })))
}

/**
 * The record as a shallow snapshot cut at `version` (a version vector, as
 * `versionAt` answers one): the history before the cut is dropped.
 */
export function exportShallowSnapshotAt(
  lease: RecordLease,
  version: readonly wire.VersionEntry[],
): Uint8Array {
  return bytesOf(
    exportedBytes(
      lease.engine.export({
        handle: lease.handle,
        mode: 'shallow-snapshot-at-version',
        version: [...version],
      }),
    ),
  )
}

/**
 * The operations the record's history starts from, as a version vector: empty
 * for a record that was never shallow.
 */
export function shallowRootVersion(lease: RecordLease): wire.VersionEntry[] {
  const { shallowRoot } = lease.engine.version({ handle: lease.handle })
  return shallowRoot.length === 0
    ? []
    : lease.engine.version({ handle: lease.handle, at: shallowRoot }).version
}

/**
 * One document of a workspace record as a document of its own, content at the
 * root; `null` when the record holds no such document. The bytes open to the
 * same content each time, not to the same bytes.
 */
export function exportProjection(lease: RecordLease, documentId: string): Uint8Array | null {
  const { bytes } = lease.engine.export({ handle: lease.handle, mode: 'projection', documentId })
  return bytes === undefined ? null : bytesOf(bytes)
}

/**
 * The documents the operations after `since` removed, with the bytes a trash
 * keeps to bring each back; see `RecordOps.removedSince`.
 */
export function removedSince(
  lease: RecordLease,
  since: readonly wire.VersionEntry[],
): RemovedDocument[] {
  const { removed } = lease.engine.export({
    handle: lease.handle,
    mode: 'removed-since',
    since: [...since],
  })
  if (removed === undefined) throw new TypeError('the engine answered no removed list')
  return removed.map(({ bytes, ...rest }) => ({ ...rest, bytes: bytesOf(bytes) }))
}

/** The operations after a version `versionOf` encoded; the whole history for `null`. */
export function exportUpdateSince(lease: RecordLease, since: Uint8Array | null): Uint8Array {
  const { engine, handle } = lease
  const from =
    since === null
      ? undefined
      : engine.decode({ kind: 'version', bytes: bytesToBase64(since) }).entries
  return bytesOf(
    exportedBytes(
      engine.export({ handle, mode: 'update', ...(from === undefined ? {} : { from }) }),
    ),
  )
}

/** Merges bytes another replica exported. `judge` is the host's own to name, never a default. */
export function importBytes(
  lease: RecordLease,
  bytes: Uint8Array,
  judge: wire.ImportJudge,
): wire.MutationResult {
  return lease.engine.import({ handle: lease.handle, bytes: bytesToBase64(bytes), judge })
}

/** One named read, answered as the value the reader produced. */
export function read<T>(lease: RecordLease, query: wire.Query, shape: AnswerShape<T>): Promise<T> {
  return readValue(lease.engine, lease.handle, query, shape)
}

/** `read` answered at once, for every query but `fileReferences`. */
export function readNow<T>(lease: RecordLease, query: wire.Query, shape: AnswerShape<T>): T {
  return unwrapAnswer(lease.engine.readNow({ handle: lease.handle, query }), query, shape)
}

/** A write the engine refused because the update it made would break a sync limit. */
export class WriteRefusedError extends Error {
  readonly breach: wire.Breach
  constructor(breach: wire.Breach) {
    super(`the write was refused as ${breach.shape}`)
    this.name = 'WriteRefusedError'
    this.breach = breach
  }
}

/**
 * Applies the batch as one commit. A refusal throws `WriteRefusedError` unless
 * the caller asks for it back with `refusal: 'return'`. `judge: 'none'` is for
 * a host whose keeper judges what it is pushed, and makes no judging copy.
 */
export function write(
  lease: RecordLease,
  batch: wire.Write[],
  options?: { readonly judge?: wire.WriteJudge },
): wire.MutationApplied
export function write(
  lease: RecordLease,
  batch: wire.Write[],
  options: { readonly refusal: 'return'; readonly judge?: wire.WriteJudge },
): wire.MutationResult
export function write(
  lease: RecordLease,
  batch: wire.Write[],
  options?: { readonly refusal?: 'return'; readonly judge?: wire.WriteJudge },
): wire.MutationResult {
  const result = lease.engine.write({
    handle: lease.handle,
    batch,
    ...(options?.judge === undefined ? {} : { judge: options.judge }),
  })
  if (result.outcome === 'refused' && options?.refusal !== 'return') {
    throw new WriteRefusedError(result.breach)
  }
  return result
}
