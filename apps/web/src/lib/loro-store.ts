/**
 * A caught read failure, as one of TWO answers: what the port can attribute
 * to the RECORD (the caller names it, since a snapshot and a delta are
 * damaged differently), and `read-unavailable` for everything else, because
 * the port names every failure it can attribute and anything left is the
 * read itself.
 *
 * One function rather than the same `if` at both reads: the kinds it picks
 * between are not interchangeable. `corrupt-snapshot` and `corrupt-delta`
 * are what the page offers `Start fresh` for, which DELETES the record, and
 * `read-unavailable` exists so a blocked read is never offered that.
 */
function readFailure(
  err: unknown,
  attributed: (
    code: string | undefined,
  ) => 'corrupt-snapshot' | 'corrupt-delta' | 'unsupported-version',
): LoroLoadResult {
  if (!isStoredDocumentUnreadableError(err)) return { kind: 'read-unavailable' }
  return { kind: attributed(err.code) }
}

/**
 * The browser's Loro persistence, as a thin layer over the `DocumentStore`
 * port.
 *
 * It is not a pass-through, and the two things it adds are the two the
 * port deliberately does not have:
 *
 * - **Chunking.** `maxChunkBytes` is the caller's, so this file names the
 *   browser's own and ports hardcodes nobody's.
 * - **Deep validation.** The port stores bytes; only a CRDT runtime can say
 *   whether they import. `LoroLoadResult`'s `corrupt-*` arms are that answer,
 *   and they stay here rather than in a contract that has no Loro.
 */

import type { DocRef, DocumentStore } from '@kamiazya/whiteboard-ports'
import {
  chunkSnapshot,
  DEFAULT_SNAPSHOT_MAX_CHUNK_BYTES,
  isStoredDocumentUnreadableError,
  KeyedSerializer,
  reassembleSnapshot,
} from '@kamiazya/whiteboard-ports'
import { Loro } from 'loro-crdt'
import { CONTENT_TIMESTAMPS_STORE } from './browser-idb.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { inTransaction, request } from './idb-tx.js'
import { openDocumentStore } from './replica-store.js'

/**
 * Narrow surface consumers need to seed, read back, and persist a document's
 * Loro bytes. Injectable so node/jsdom tests can supply an in-memory fake
 * instead of touching real IndexedDB or the loro-crdt library directly. It
 * lives beside the concrete `LoroStore` so lower-level `lib/` modules never
 * have to reach up into `pages/` for the type.
 */
export interface LoroStoreLike {
  save(documentId: string, snapshot: Uint8Array): Promise<void>
  createEmptySnapshot(): Uint8Array
  load(documentId: string): Promise<LoroLoadResult>
}

export type LoroLoadResult =
  | { kind: 'ok'; snapshot: Uint8Array; deltas?: Uint8Array[] }
  | { kind: 'not-found' }
  | { kind: 'corrupt-snapshot' }
  | { kind: 'corrupt-delta' }
  | { kind: 'unsupported-version' }
  /**
   * The read did not COMPLETE. Deliberately not one of the three above: those
   * are verdicts on the stored bytes, and this one has none — IndexedDB fails
   * transiently for reasons that say nothing about the document (a connection
   * closing under a version change, an aborted transaction, a quota error).
   * Folding those into `corrupt-snapshot` told a user their data was
   * unreadable and offered to delete it.
   */
  | { kind: 'read-unavailable' }

const EMPTY_FRONTIER = new Uint8Array()

function refOf(documentId: string): DocRef {
  // Every document this store keeps lives in the browser's own workspace.
  return { kind: 'document', workspaceId: getBrowserWorkspaceId(), documentId }
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
 * Record when a document's content was last written — the browser listing's
 * `updatedAt` source. Standalone because more than one writer stamps it: this
 * store's own save paths, and the workspace-document write path, which does
 * not go through this store at all. Best-effort: a listing that shows the
 * epoch is worse than one that shows the truth, but neither is worth failing
 * a save the user's document depends on.
 */
export async function touchContentTimestamp(documentId: string, dbName?: string): Promise<void> {
  try {
    await inTransaction(dbName, [CONTENT_TIMESTAMPS_STORE], 'readwrite', async (tx) => {
      await request(
        tx.objectStore(CONTENT_TIMESTAMPS_STORE).put(new Date().toISOString(), documentId),
      )
    })
  } catch {
    // Intentionally swallowed; see above.
  }
}

export class LoroStore {
  readonly #store: DocumentStore

  /**
   * Serialises this instance's operations per document.
   *
   * `load` reads the snapshot and then the log, and that spans more than one
   * port call, so a single IndexedDB transaction does not cover it. The daemon
   * has the same shape and answers it the same way (`withWorkspaceWriteLock`):
   * the lock is what stops a write landing between the two reads.
   *
   * ponytail: per-instance, so it does not reach across tabs. Neither does
   * the daemon's, across processes — and the browser's real cross-tab story
   * is a `SharedWorker`, not a lock in each page.
   */
  readonly #writes = new KeyedSerializer()

  /**
   * Which database to talk to. Production never passes it; a browser test
   * does, so its fixtures cannot collide with another test FILE's — they
   * share an origin, and therefore one `whiteboard` database.
   *
   * `store` is the same kind of seam and exists for one reason a database
   * name cannot serve: a read that FAILS rather than finds nothing (a blocked
   * transaction) cannot be produced by seeding a database, and a wrapper
   * around the port can. Production passes nothing and gets the sealed-aware
   * store `openDocumentStore` always builds.
   */
  constructor(
    private readonly dbName?: string,
    store?: DocumentStore,
  ) {
    this.#store = store ?? openDocumentStore(dbName)
  }

  #serialise<T>(documentId: string, body: () => Promise<T>): Promise<T> {
    return this.#writes.run(documentId, body)
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
   * The read is two port calls — the snapshot, then the log — and a write
   * landing between them would pair a snapshot with a log from a different
   * generation of the record: a document missing edits. Nothing re-reads
   * afterwards, so that stale answer is what the editor would open.
   */
  async load(documentId: string): Promise<LoroLoadResult> {
    return this.#serialise(documentId, () => this.#loadInner(documentId))
  }

  async #loadInner(documentId: string): Promise<LoroLoadResult> {
    const docRef = refOf(documentId)
    let stored: Awaited<ReturnType<DocumentStore['loadSnapshot']>>
    try {
      stored = await this.#store.loadSnapshot({ docRef })
    } catch (err) {
      return readFailure(err, (code) =>
        code === 'unsupported-version' ? 'unsupported-version' : 'corrupt-snapshot',
      )
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
      updates = (await this.#store.loadDeltas({ docRef, afterSeq: null })).updates
    } catch (err) {
      return readFailure(err, () => 'corrupt-delta')
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
      const { manifest, chunks } = chunkSnapshot(snapshot, DEFAULT_SNAPSHOT_MAX_CHUNK_BYTES)
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
   * Record when this document's content was last written.
   *
   * Separate from the snapshot because it belongs to neither port — see
   * `CONTENT_TIMESTAMPS_STORE`. Best-effort: a listing that shows the epoch
   * is worse than one that shows the truth, but neither is worth failing a
   * save the user's document depends on.
   */
  async #touch(documentId: string): Promise<void> {
    await touchContentTimestamp(documentId, this.dbName)
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
