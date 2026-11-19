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
import { exportedBytes } from './answers.js'
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
  readonly entries: wire.VersionEntry[]
  readonly frontiers: wire.VersionEntry[]
}

export function versionOf(lease: RecordLease): LeaseVersion {
  const answer = lease.engine.version({ handle: lease.handle })
  return {
    encoded: bytesOf(answer.encodedVersion),
    entries: answer.version,
    frontiers: answer.frontiers,
  }
}

export function exportSnapshot(lease: RecordLease): Uint8Array {
  return bytesOf(exportedBytes(lease.engine.export({ handle: lease.handle, mode: 'snapshot' })))
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
 * the caller asks for it back with `refusal: 'return'`.
 */
export function write(lease: RecordLease, batch: wire.Write[]): wire.MutationApplied
export function write(
  lease: RecordLease,
  batch: wire.Write[],
  options: { readonly refusal: 'return' },
): wire.MutationResult
export function write(
  lease: RecordLease,
  batch: wire.Write[],
  options?: { readonly refusal: 'return' },
): wire.MutationResult {
  const result = lease.engine.write({ handle: lease.handle, batch })
  if (result.outcome === 'refused' && options?.refusal !== 'return') {
    throw new WriteRefusedError(result.breach)
  }
  return result
}
