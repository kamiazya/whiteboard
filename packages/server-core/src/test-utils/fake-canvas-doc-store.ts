import type {
  AppendDeltasInput,
  AppendDeltasResult,
  CanvasDocStore,
  LoadDeltasInput,
  LoadDeltasResult,
  LoadSnapshotInput,
  LoadSnapshotResult,
  ReadFrontierInput,
  ReadFrontierResult,
  SaveSnapshotInput,
} from '@kamiazya/whiteboard-canvas-ports'
import { chunkSnapshot } from '@kamiazya/whiteboard-canvas-ports'
import type { CanvasId } from '@kamiazya/whiteboard-canvas-model'
import { LoroDoc } from 'loro-crdt'

const SNAPSHOT_MAX_CHUNK_BYTES = 1_000_000

/** In-memory `CanvasDocStore` fake for server-core tool tests. */
export class FakeCanvasDocStore implements CanvasDocStore {
  private saved: SaveSnapshotInput | undefined

  async loadSnapshot(_input: LoadSnapshotInput): Promise<LoadSnapshotResult> {
    if (this.saved === undefined) return null
    return {
      manifest: this.saved.manifest,
      chunks: this.saved.chunks,
      frontier: this.saved.frontier,
    }
  }

  async saveSnapshot(input: SaveSnapshotInput): Promise<void> {
    this.saved = input
  }

  async appendDeltas(_input: AppendDeltasInput): Promise<AppendDeltasResult> {
    throw new Error('not implemented')
  }

  async loadDeltas(_input: LoadDeltasInput): Promise<LoadDeltasResult> {
    throw new Error('not implemented')
  }

  async readFrontier(_input: ReadFrontierInput): Promise<ReadFrontierResult> {
    throw new Error('not implemented')
  }
}

/**
 * Configures a `LoroDoc` via `configure`, then snapshots it into the
 * given `FakeCanvasDocStore` under the provided `canvasId`.
 */
export async function seedDoc(
  store: FakeCanvasDocStore,
  canvasId: CanvasId,
  configure: (doc: LoroDoc) => void,
): Promise<void> {
  const doc = new LoroDoc()
  configure(doc)
  const { manifest, chunks } = chunkSnapshot(
    doc.export({ mode: 'snapshot' }),
    SNAPSHOT_MAX_CHUNK_BYTES,
  )
  await store.saveSnapshot({
    docRef: { kind: 'canvas', canvasId },
    manifest,
    chunks,
    frontier: doc.oplogVersion().encode() as Uint8Array<ArrayBuffer>,
  })
}
