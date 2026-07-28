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
import { CanvasNotFoundError } from '../render/load-spatial-canvas.js'
import { createCanvasExportJsonCanvasTool } from './canvas-export-json-canvas.js'

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

const NODE_WITH_EXTENSION = {
  id: 'n1',
  type: 'text' as const,
  x: 0,
  y: 0,
  width: 100,
  height: 50,
  text: 'hi',
  'x-whiteboard': { kind: 'shape' as const, shape: 'rectangle' as const },
}

async function seedWithExtensionNode(canvasDocStore: FakeCanvasDocStore): Promise<void> {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, { nodes: [NODE_WITH_EXTENSION], edges: [] })
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
}

describe('canvas_export_json_canvas tool', () => {
  test('strict mode drops the x-whiteboard extension key', async () => {
    const canvasDocStore = new FakeCanvasDocStore()
    await seedWithExtensionNode(canvasDocStore)
    const tool = createCanvasExportJsonCanvasTool({
      canvasDocStore,
      workspaceIndex: {} as never,
      blobStore: {} as never,
    })

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      canvasId: CANVAS_ID,
      options: { strict: true },
    })
    const parsed = JSON.parse(result.json)

    expect(parsed.nodes[0]['x-whiteboard']).toBeUndefined()
  })

  test('extended mode (default) round-trips the x-whiteboard extension losslessly', async () => {
    const canvasDocStore = new FakeCanvasDocStore()
    await seedWithExtensionNode(canvasDocStore)
    const tool = createCanvasExportJsonCanvasTool({
      canvasDocStore,
      workspaceIndex: {} as never,
      blobStore: {} as never,
    })

    const result = await tool.execute({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID })
    const parsed = JSON.parse(result.json)

    expect(parsed.nodes[0]['x-whiteboard']).toEqual({ kind: 'shape', shape: 'rectangle' })
  })

  test('rejects when the canvas has no stored snapshot', async () => {
    const canvasDocStore = new FakeCanvasDocStore()
    const tool = createCanvasExportJsonCanvasTool({
      canvasDocStore,
      workspaceIndex: {} as never,
      blobStore: {} as never,
    })

    await expect(tool.execute({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID })).rejects.toThrow(
      CanvasNotFoundError,
    )
  })
})
