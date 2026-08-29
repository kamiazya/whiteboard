import type {
  AppendDeltasInput,
  AppendDeltasResult,
  DeleteDocInput,
  DocRef,
  DocumentStore,
  Frontier,
  LoadDeltasInput,
  LoadDeltasResult,
  LoadSnapshotInput,
  LoadSnapshotResult,
  ReadFrontierInput,
  ReadFrontierResult,
  ReadSnapshotManifestInput,
  ReadSnapshotManifestResult,
  SaveCompactedSnapshotInput,
  SaveCompactedSnapshotResult,
  SaveSnapshotInput,
  SnapshotChunk,
  SnapshotManifest,
  StoredDocumentUnreadableCode,
} from '@kamiazya/whiteboard-ports'
import { docRefKey, StoredDocumentUnreadableError } from '@kamiazya/whiteboard-ports'
import { cloneBytes } from './clone-bytes.js'

/**
 * What a stored record can be. The `unreadable` arm exists so this double can
 * reach the state a real store reaches on its own — a record written by a
 * shape the reader does not know — which the port's conformance suite
 * requires every implementation to be able to produce.
 */
interface DocRecord {
  readonly snapshot: {
    readonly manifest: SnapshotManifest
    readonly chunks: SnapshotChunk[]
  } | null
  readonly frontier: Frontier | null
  readonly deltas: readonly Uint8Array[]
  /** ADR-0020's fencing token. Advanced by every write that replaces the
   *  snapshot; meaningless while `snapshot` is null. */
  readonly generation: number
  readonly unreadable?: StoredDocumentUnreadableCode
}

function emptyRecord(): DocRecord {
  return { snapshot: null, frontier: null, deltas: [], generation: 0 }
}

function cloneChunk(chunk: SnapshotChunk): SnapshotChunk {
  return { ...chunk, bytes: cloneBytes(chunk.bytes) }
}

/**
 * In-memory `DocumentStore` test double. Every stored/returned byte buffer
 * is defensively copied so a caller mutating its own input/output array can
 * never corrupt or observe the store's internal state — this is the
 * canonical double the later libSQL-backed implementation's tests reuse for
 * behavioral parity checks.
 */
export class InMemoryDocumentStore implements DocumentStore {
  private readonly docs = new Map<string, DocRecord>()

  private getRecord(key: string): DocRecord {
    return this.docs.get(key) ?? emptyRecord()
  }

  /**
   * Put a record this store cannot read under `docRef`. Test-only, and named
   * so at the call site: the port's conformance suite needs every
   * implementation to be able to reach that state.
   */
  writeUnreadableRecord(docRef: DocRef): void {
    const key = docRefKey(docRef)
    this.docs.set(key, { ...this.getRecord(key), unreadable: 'malformed' })
  }

  async readSnapshotManifest(
    input: ReadSnapshotManifestInput,
  ): Promise<ReadSnapshotManifestResult> {
    const record = this.docs.get(docRefKey(input.docRef))
    if (record?.unreadable !== undefined) {
      throw new StoredDocumentUnreadableError(
        record.unreadable,
        `Stored document ${docRefKey(input.docRef)} is unreadable: ${record.unreadable}`,
      )
    }
    // The same two conditions `loadSnapshot` answers null on, written out
    // rather than delegating: this must stay cheap, and delegating is exactly
    // the shortcut that would make it cost the whole snapshot.
    if (!record?.snapshot || !record.frontier) {
      return null
    }
    return { manifest: record.snapshot.manifest, generation: record.generation }
  }

  async loadSnapshot(input: LoadSnapshotInput): Promise<LoadSnapshotResult> {
    const record = this.docs.get(docRefKey(input.docRef))
    if (record?.unreadable !== undefined) {
      throw new StoredDocumentUnreadableError(
        record.unreadable,
        `Stored document ${docRefKey(input.docRef)} is unreadable: ${record.unreadable}`,
      )
    }
    if (!record?.snapshot || !record.frontier) {
      return null
    }
    return {
      manifest: record.snapshot.manifest,
      // Sorted by index, not returned in insertion order: the libSQL store
      // reads its chunks back through `order by chunkIndex`, so a double that
      // preserved write order would let a test pass against the double and
      // fail against the real store — the exact drift the shared conformance
      // suite exists to catch, and did.
      chunks: [...record.snapshot.chunks].sort((a, b) => a.index - b.index).map(cloneChunk),
      frontier: cloneBytes(record.frontier),
    }
  }

  async saveSnapshot(input: SaveSnapshotInput): Promise<void> {
    const key = docRefKey(input.docRef)
    const existing = this.getRecord(key)
    this.docs.set(key, {
      ...existing,
      snapshot: {
        manifest: input.manifest,
        chunks: input.chunks.map(cloneChunk),
      },
      frontier: cloneBytes(input.frontier),
      // Unconditional, but still fenced: a fold computed against the content
      // this call just replaced must not be accepted afterwards and undo it.
      generation: existing.generation + 1,
    })
  }

  /**
   * ONE map write, with no `await` between reading the record and replacing
   * it. Delegating to `saveSnapshot` and then clearing looked equivalent and
   * was not: the await let a concurrent `appendDeltas` land in between, and
   * the clear then threw away an update that could not be in the snapshot.
   */
  async saveCompactedSnapshot(
    input: SaveCompactedSnapshotInput,
  ): Promise<SaveCompactedSnapshotResult> {
    const key = docRefKey(input.docRef)
    const existing = this.getRecord(key)
    // `null` expects no snapshot; a number expects exactly that generation.
    const current = existing.snapshot === null ? null : existing.generation
    if (current !== input.expectedGeneration) {
      return { ok: false, currentGeneration: current }
    }
    const generation = existing.generation + 1
    this.docs.set(key, {
      snapshot: { manifest: input.manifest, chunks: input.chunks.map(cloneChunk) },
      frontier: cloneBytes(input.frontier),
      // Exactly the superseded prefix. Anything appended after the caller
      // folded is not in the snapshot and stays.
      deltas: existing.deltas.slice(input.supersededDeltaCount),
      generation,
    })
    return { ok: true, generation }
  }

  async appendDeltas(input: AppendDeltasInput): Promise<AppendDeltasResult> {
    const key = docRefKey(input.docRef)
    const existing = this.getRecord(key)
    const frontier = cloneBytes(input.deltaBatch.newFrontier)
    this.docs.set(key, {
      ...existing,
      deltas: [...existing.deltas, ...input.deltaBatch.updates.map(cloneBytes)],
      frontier,
    })
    return { frontier: cloneBytes(frontier) }
  }

  /**
   * `sinceFrontier` is intentionally ignored: comparing frontiers is a
   * loro-crdt runtime concern (frontiers are an opaque `Uint8Array` at the
   * `ports` contract layer), not something this in-memory test
   * double can do on its own. It always returns the full accumulated delta
   * log for the doc; a future libSQL-backed store that actually filters by
   * frontier remains behaviorally compatible with every caller of this
   * double because "everything since the start" is always a superset of
   * "everything since `sinceFrontier`".
   */
  async loadDeltas(input: LoadDeltasInput): Promise<LoadDeltasResult> {
    const record = this.docs.get(docRefKey(input.docRef))
    if (!record) {
      return { updates: [], frontier: new Uint8Array() }
    }
    return {
      updates: record.deltas.map(cloneBytes),
      frontier: record.frontier ? cloneBytes(record.frontier) : new Uint8Array(),
    }
  }

  async readFrontier(input: ReadFrontierInput): Promise<ReadFrontierResult> {
    const record = this.docs.get(docRefKey(input.docRef))
    if (!record?.frontier) {
      return null
    }
    return { frontier: cloneBytes(record.frontier) }
  }

  async deleteDoc(input: DeleteDocInput): Promise<void> {
    this.docs.delete(docRefKey(input.docRef))
  }
}
