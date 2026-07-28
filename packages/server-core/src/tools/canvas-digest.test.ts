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
import { sceneDigest, sceneDigestSchema } from '@kamiazya/whiteboard-canvas-render'
import { writeSpatialCanvas } from '@kamiazya/whiteboard-canvas-workspace'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, test } from 'vitest'
import { composeCanvasScene } from '../render/compose-canvas-scene.js'
import { fallbackMeasureText } from '../render/fallback-measure.js'
import { CanvasNotFoundError } from '../render/load-spatial-canvas.js'
import { createCanvasDigestTool } from './canvas-digest.js'

const CANVAS_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'
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

describe('canvas_digest tool', () => {
  test('matches sceneDigest computed directly over an overlapping two-node canvas', async () => {
    const canvasDocStore = new FakeCanvasDocStore()
    const canvas = {
      nodes: [
        { id: 'n1', type: 'group' as const, x: 0, y: 0, width: 100, height: 100 },
        { id: 'n2', type: 'group' as const, x: 50, y: 50, width: 100, height: 100 },
      ],
      edges: [],
    }
    const doc = new LoroDoc()
    writeSpatialCanvas(doc, canvas)
    const { manifest, chunks } = chunkSnapshot(
      doc.export({ mode: 'snapshot' }),
      SNAPSHOT_MAX_CHUNK_BYTES,
    )
    await canvasDocStore.saveSnapshot({
      docRef: { kind: 'canvas', canvasId: CANVAS_ID },
      manifest,
      chunks,
      frontier: doc.oplogVersion().encode() as Uint8Array<ArrayBuffer>,
    })

    const tool = createCanvasDigestTool({
      canvasDocStore,
      workspaceIndex: {} as never,
      blobStore: {} as never,
    })

    const result = await tool.execute({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID })
    const expected = sceneDigest(composeCanvasScene(canvas, fallbackMeasureText))

    expect(result).toEqual(expected)
    expect(result.overlaps.length).toBeGreaterThan(0)
    expect(() => sceneDigestSchema.parse(result)).not.toThrow()
  })

  test('rejects when the canvas has no stored snapshot', async () => {
    const canvasDocStore = new FakeCanvasDocStore()
    const tool = createCanvasDigestTool({
      canvasDocStore,
      workspaceIndex: {} as never,
      blobStore: {} as never,
    })

    await expect(tool.execute({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID })).rejects.toThrow(
      CanvasNotFoundError,
    )
  })
})
