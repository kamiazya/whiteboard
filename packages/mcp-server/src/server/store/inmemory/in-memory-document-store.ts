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
  /** The seq the NEXT appended update gets. Monotonic across truncations —
   *  `deltas[i]` carries `nextSeq - deltas.length + i` — which is what lets a
   *  tail resume without re-reading what it has. */
  readonly nextSeq: number
  /** ADR-0020's fencing token. Advanced by every write that replaces the
   *  snapshot; meaningless while `snapshot` is null. */
  readonly generation: number
  readonly unreadable?: StoredDocumentUnreadableCode
}

function emptyRecord(): DocRecord {
  return { snapshot: null, frontier: null, deltas: [], nextSeq: 1, generation: 0 }
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
      // NOT reset. A fold shortens the array without moving the seqs already
      // handed out, which is what keeps a tail's cursor meaningful across it.
      nextSeq: existing.nextSeq,
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
      nextSeq: existing.nextSeq + input.deltaBatch.updates.length,
      frontier,
    })
    return { frontier: cloneBytes(frontier) }
  }

  /**
   * Tails by seq. `deltas[i]` carries `nextSeq - deltas.length + i`, so a
   * truncating fold shifts the array without shifting the seqs — which is the
   * whole point of storing `nextSeq` rather than deriving a position from the
   * array index.
   */
  async loadDeltas(input: LoadDeltasInput): Promise<LoadDeltasResult> {
    const record = this.docs.get(docRefKey(input.docRef))
    if (!record) {
      return { updates: [], lastSeq: null, generation: null, frontier: new Uint8Array() }
    }
    const firstSeq = record.nextSeq - record.deltas.length
    const after = input.afterSeq ?? firstSeq - 1
    const updates = record.deltas.filter((_, index) => firstSeq + index > after).map(cloneBytes)
    return {
      updates,
      lastSeq: record.deltas.length === 0 ? null : record.nextSeq - 1,
      generation: record.snapshot === null ? null : record.generation,
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
