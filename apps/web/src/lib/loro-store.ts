/**
 * The browser's Loro persistence, as a thin layer over the `DocumentStore`
 * port.
 *
 * It is not a pass-through, and the three things it adds are the three the
 * port deliberately does not have:
 *
 * - **Chunking.** `maxChunkBytes` is the caller's, so this file names the
 *   browser's own and ports hardcodes nobody's.
 * - **Deep validation.** The port stores bytes; only a CRDT runtime can say
 *   whether they import. `LoroLoadResult`'s `corrupt-*` arms are that answer,
 *   and they stay here rather than in a contract that has no Loro.
 * - **Compaction.** Deciding a log is worth folding needs to replay it, which
 *   again needs the runtime. The port supplies the one operation that makes
 *   the result safe to store (`saveCompactedSnapshot`); choosing to call it is
 *   this file's.
 */

import type { DocRef } from '@kamiazya/whiteboard-ports'
import {
  chunkSnapshot,
  isStoredDocumentUnreadableError,
  reassembleSnapshot,
} from '@kamiazya/whiteboard-ports'
import { Loro } from 'loro-crdt'
import { CONTENT_TIMESTAMPS_STORE } from './browser-idb.js'
import { IdbDocumentStore } from './idb-document-store.js'
import { inTransaction, request } from './idb-tx.js'
import { shouldCompact } from './loro-compaction.js'

export type LoroLoadResult =
  | { kind: 'ok'; snapshot: Uint8Array; deltas?: Uint8Array[] }
  | { kind: 'not-found' }
  | { kind: 'corrupt-snapshot' }
  | { kind: 'corrupt-delta' }
  | { kind: 'unsupported-version' }

/**
 * Where a browser-local snapshot is split for storage.
 *
 * Not the daemon's `SNAPSHOT_MAX_CHUNK_BYTES`, and not `COMPACT_DELTA_BYTES`
 * either: this is the size a stored value is broken at, which is a different
 * question from where a log stops being worth keeping. IndexedDB has no
 * message cap to respect, so this is generous — a single-chunk snapshot is
 * the normal case and the chunking exists to satisfy the contract, not to
 * work around a limit.
 */
const MAX_CHUNK_BYTES = 1_000_000

const EMPTY_FRONTIER = new Uint8Array()

function refOf(documentId: string): DocRef {
  return { kind: 'document', documentId }
}

/**
 * Try importing bytes into a throwaway LoroDoc to confirm they are valid Loro
 * bytes (snapshot or update). Returns false if the import throws.
 */
function isValidLoroBytes(bytes: Uint8Array): boolean {
  try {
    const probe = new Loro()
    probe.import(bytes)
    return true
  } catch {
    return false
  }
}

/**
 * Replay a record into one snapshot. Returns null when any byte refuses to
 * import — an unfoldable log is left exactly as it was, because losing edits
 * to save space is not a trade this is allowed to make.
 */
function foldDeltas(snapshot: Uint8Array, deltas: readonly Uint8Array[]): Uint8Array | null {
  try {
    const doc = new Loro()
    doc.import(snapshot)
    for (const delta of deltas) doc.import(delta)
    return doc.export({ mode: 'snapshot' })
  } catch {
    return null
  }
}

export class LoroStore {
  readonly #store: IdbDocumentStore

  /**
   * Serialises this instance's read-modify-write sequences per document.
   *
   * `appendDelta` reads the log, decides whether to fold it, and writes — and
   * that spans more than one port call, so a single IndexedDB transaction no
   * longer covers it. The daemon has the same shape and answers it the same
   * way (`withDocumentWriteLock`): the lock is what stops two overlapping
   * appends from both deciding to compact and the second's fold discarding
   * the first's update.
   *
   * ponytail: per-instance, so it does not reach across tabs. Neither does
   * the daemon's, across processes — and the browser's real cross-tab story
   * is a `SharedWorker`, not a lock in each page.
   */
  readonly #writes = new Map<string, Promise<unknown>>()

  /**
   * Which database to talk to. Production never passes it; a browser test
   * does, so its fixtures cannot collide with another test FILE's — they
   * share an origin, and therefore one `whiteboard` database.
   */
  constructor(private readonly dbName?: string) {
    this.#store = new IdbDocumentStore(dbName)
  }

  #serialise<T>(documentId: string, body: () => Promise<T>): Promise<T> {
    const previous = this.#writes.get(documentId) ?? Promise.resolve()
    // `.then` on a settled-or-not predecessor, and `.catch` so one failed
    // write does not poison every later one for the same document.
    const next = previous.then(body, body)
    this.#writes.set(
      documentId,
      next.catch(() => {}),
    )
    return next
  }

  /**
   * Bytes for a brand-new, empty Loro document snapshot. Callers that only
   * need to seed a fresh canvas (e.g. the page-layer create-canvas flow) use
   * this instead of importing `loro-crdt` themselves, keeping CRDT-library
   * knowledge (the `{ mode: 'snapshot' }` export API) confined to this file.
   */
  createEmptySnapshot(): Uint8Array {
    return new Loro().export({ mode: 'snapshot' })
  }

  /**
   * Serialised against this instance's writes, not just against each other.
   *
   * The read is two port calls — the snapshot, then the log — and a
   * compaction landing between them would hand back a PRE-compaction snapshot
   * with a POST-compaction (emptied) log: a document missing every edit the
   * fold had just absorbed. Nothing re-reads afterwards, so that stale answer
   * is what the editor would open.
   */
  async load(documentId: string): Promise<LoroLoadResult> {
    return this.#serialise(documentId, () => this.#loadInner(documentId))
  }

  async #loadInner(documentId: string): Promise<LoroLoadResult> {
    const docRef = refOf(documentId)
    let stored: Awaited<ReturnType<IdbDocumentStore['loadSnapshot']>>
    try {
      stored = await this.#store.loadSnapshot({ docRef })
    } catch (err) {
      // The port names this failure instead of folding it into "absent", so
      // the two stay two answers here as well: one tells a user their build
      // is old, the other that their document is damaged.
      if (isStoredDocumentUnreadableError(err)) {
        return {
          kind: err.code === 'unsupported-version' ? 'unsupported-version' : 'corrupt-snapshot',
        }
      }
      return { kind: 'corrupt-snapshot' }
    }
    if (stored === null) return { kind: 'not-found' }

    let snapshot: Uint8Array
    try {
      snapshot = reassembleSnapshot(stored.manifest, stored.chunks)
    } catch {
      return { kind: 'corrupt-snapshot' }
    }
    // Deep-validate: the port stores bytes and cannot tell whether they are
    // Loro's. A structurally perfect record carrying nonsense is still a
    // corrupt snapshot to everyone downstream.
    if (!isValidLoroBytes(snapshot)) return { kind: 'corrupt-snapshot' }

    let updates: Uint8Array[]
    try {
      updates = (await this.#store.loadDeltas({ docRef, sinceFrontier: EMPTY_FRONTIER })).updates
    } catch {
      return { kind: 'corrupt-delta' }
    }
    for (const delta of updates) {
      if (!isValidLoroBytes(delta)) return { kind: 'corrupt-delta' }
    }

    return {
      kind: 'ok',
      snapshot,
      // Absent rather than an empty array when there is no log, matching what
      // callers already branch on.
      ...(updates.length > 0 ? { deltas: updates } : {}),
    }
  }

  async save(documentId: string, snapshot: Uint8Array): Promise<void> {
    return this.#serialise(documentId, async () => {
      const { manifest, chunks } = chunkSnapshot(snapshot, MAX_CHUNK_BYTES)
      await this.#store.saveSnapshot({
        docRef: refOf(documentId),
        manifest,
        chunks,
        // Empty, deliberately: nothing in the browser reads a frontier yet.
        // The port's delta/frontier half is implemented and unused until
        // something that genuinely compares frontiers (daemon sync parity,
        // cross-tab) exists — and inventing a value here would be a lie the
        // first real reader would have to unpick.
        frontier: EMPTY_FRONTIER,
      })
      await this.#touch(documentId)
    })
  }

  /**
   * Append an incremental Loro update to a document's delta log, folding the
   * log back into the snapshot once it is worth it.
   *
   * A no-op when the document has no snapshot yet: a log with no base is
   * storage nothing can load, and the caller's contract is that a snapshot is
   * saved first.
   */
  async appendDelta(documentId: string, delta: Uint8Array): Promise<void> {
    return this.#serialise(documentId, async () => {
      const docRef = refOf(documentId)
      const stored = await this.#store.loadSnapshot({ docRef })
      if (stored === null) return

      const existing = (await this.#store.loadDeltas({ docRef, sinceFrontier: EMPTY_FRONTIER }))
        .updates
      const deltas = [...existing, delta]

      // Folding HERE rather than on read: this is the one place that already
      // knows the whole log, and a fresh open never pays for a log someone
      // else's session grew. Measured at the budget, the fold costs about
      // 10ms of synchronous replay and happens once per 64KB written.
      const folded = shouldCompact(deltas)
        ? foldDeltas(reassembleSnapshot(stored.manifest, stored.chunks), deltas)
        : null

      if (folded === null) {
        await this.#store.appendDeltas({
          docRef,
          // Copied so the DTO's narrow `Uint8Array<ArrayBuffer>` is satisfied
          // without a cast; see `idb-document-store`'s note on the variance.
          deltaBatch: { updates: [new Uint8Array(delta)], newFrontier: EMPTY_FRONTIER },
        })
      } else {
        const { manifest, chunks } = chunkSnapshot(folded, MAX_CHUNK_BYTES)
        // One operation, not save-then-clear: the port has it precisely so
        // this cannot drop an append that lands between the two halves.
        await this.#store.saveCompactedSnapshot({
          docRef,
          manifest,
          chunks,
          frontier: EMPTY_FRONTIER,
          // What the fold consumed: the log AS READ. The new delta is folded
          // in too but was never written, so it is not part of the count —
          // and anything appended since this read is neither superseded nor
          // in the snapshot, which is exactly what the count protects.
          supersededDeltaCount: existing.length,
        })
      }
      await this.#touch(documentId)
    })
  }

  /**
   * Record when this document's content was last written.
   *
   * Separate from the snapshot because it belongs to neither port — see
   * `CONTENT_TIMESTAMPS_STORE`. Best-effort: a listing that shows the epoch
   * is worse than one that shows the truth, but neither is worth failing a
   * save the user's document depends on.
   */
  async #touch(documentId: string): Promise<void> {
    try {
      await inTransaction(this.dbName, [CONTENT_TIMESTAMPS_STORE], 'readwrite', async (tx) => {
        await request(
          tx.objectStore(CONTENT_TIMESTAMPS_STORE).put(new Date().toISOString(), documentId),
        )
      })
    } catch {
      // Intentionally swallowed; see above.
    }
  }

  /** Drop everything stored for a document — snapshot, log and timestamp. */
  async remove(documentId: string): Promise<void> {
    return this.#serialise(documentId, async () => {
      await this.#store.deleteDoc({ docRef: refOf(documentId) })
      await inTransaction(this.dbName, [CONTENT_TIMESTAMPS_STORE], 'readwrite', async (tx) => {
        await request(tx.objectStore(CONTENT_TIMESTAMPS_STORE).delete(documentId))
      })
    })
  }
}
