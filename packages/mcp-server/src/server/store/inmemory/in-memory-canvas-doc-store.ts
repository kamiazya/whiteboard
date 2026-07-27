import type {
  AppendDeltasInput,
  AppendDeltasResult,
  CanvasDocStore,
  Frontier,
  LoadDeltasInput,
  LoadDeltasResult,
  LoadSnapshotInput,
  LoadSnapshotResult,
  ReadFrontierInput,
  ReadFrontierResult,
  SaveSnapshotInput,
  SnapshotChunk,
  SnapshotManifest,
} from '@kamiazya/whiteboard-canvas-ports'
import { docRefKey } from './doc-ref-key.js'

interface DocRecord {
  readonly snapshot: {
    readonly manifest: SnapshotManifest
    readonly chunks: SnapshotChunk[]
  } | null
  readonly frontier: Frontier | null
  readonly deltas: readonly Uint8Array[]
}

function emptyRecord(): DocRecord {
  return { snapshot: null, frontier: null, deltas: [] }
}

function cloneBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  // `new Uint8Array(bytes)` (the array-like overload) always allocates a
  // fresh `ArrayBuffer` — unlike `Uint8Array.from`, whose return type widens
  // to `ArrayBufferLike` and no longer matches canvas-ports' DTOs.
  return new Uint8Array(bytes)
}

function cloneChunk(chunk: SnapshotChunk): SnapshotChunk {
  return { ...chunk, bytes: cloneBytes(chunk.bytes) }
}

/**
 * In-memory `CanvasDocStore` test double. Every stored/returned byte buffer
 * is defensively copied so a caller mutating its own input/output array can
 * never corrupt or observe the store's internal state — this is the
 * canonical double the later libSQL-backed implementation's tests reuse for
 * behavioral parity checks.
 */
export class InMemoryCanvasDocStore implements CanvasDocStore {
  private readonly docs = new Map<string, DocRecord>()

  private getRecord(key: string): DocRecord {
    return this.docs.get(key) ?? emptyRecord()
  }

  async loadSnapshot(input: LoadSnapshotInput): Promise<LoadSnapshotResult> {
    const record = this.docs.get(docRefKey(input.docRef))
    if (!record || !record.snapshot || !record.frontier) {
      return null
    }
    return {
      manifest: record.snapshot.manifest,
      chunks: record.snapshot.chunks.map(cloneChunk),
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
    })
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
    if (!record || !record.frontier) {
      return null
    }
    return { frontier: cloneBytes(record.frontier) }
  }
}
