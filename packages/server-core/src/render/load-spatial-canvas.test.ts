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
import { writeSpatialCanvas } from '@kamiazya/whiteboard-canvas-workspace'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, test } from 'vitest'
import { CanvasNotFoundError, loadSpatialCanvas } from './load-spatial-canvas.js'

const CANVAS_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const SNAPSHOT_MAX_CHUNK_BYTES = 1_000_000

class FakeCanvasDocStore implements CanvasDocStore {
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

describe('loadSpatialCanvas', () => {
  test('throws CanvasNotFoundError when no snapshot exists', async () => {
    const canvasDocStore = new FakeCanvasDocStore()
    const deps = { canvasDocStore, workspaceIndex: {} as never, blobStore: {} as never }

    await expect(loadSpatialCanvas(deps, CANVAS_ID)).rejects.toThrow(CanvasNotFoundError)
  })

  test('returns the doc and decoded canvas for an existing snapshot', async () => {
    const canvasDocStore = new FakeCanvasDocStore()
    const seedDoc = new LoroDoc()
    writeSpatialCanvas(seedDoc, {
      nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'hello' }],
      edges: [],
    })
    const { manifest, chunks } = chunkSnapshot(
      seedDoc.export({ mode: 'snapshot' }),
      SNAPSHOT_MAX_CHUNK_BYTES,
    )
    await canvasDocStore.saveSnapshot({
      docRef: { kind: 'canvas', canvasId: CANVAS_ID },
      manifest,
      chunks,
      frontier: seedDoc.oplogVersion().encode() as Uint8Array<ArrayBuffer>,
    })

    const deps = { canvasDocStore, workspaceIndex: {} as never, blobStore: {} as never }
    const { doc, canvas } = await loadSpatialCanvas(deps, CANVAS_ID)

    expect(doc).toBeInstanceOf(LoroDoc)
    expect(canvas.nodes).toEqual([
      { id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'hello' },
    ])
  })
})
