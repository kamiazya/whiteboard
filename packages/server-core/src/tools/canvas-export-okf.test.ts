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
import { writeFacets, writeSpatialCanvas } from '@kamiazya/whiteboard-canvas-workspace'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, test } from 'vitest'
import { CanvasNotFoundError } from '../render/load-spatial-canvas.js'
import { createCanvasExportOkfTool } from './canvas-export-okf.js'

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

async function seed(
  canvasDocStore: FakeCanvasDocStore,
  configure: (doc: LoroDoc) => void,
): Promise<void> {
  const doc = new LoroDoc()
  configure(doc)
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

describe('canvas_export_okf tool', () => {
  test('exports the first text node body with facets from the doc', async () => {
    const canvasDocStore = new FakeCanvasDocStore()
    await seed(canvasDocStore, (doc) => {
      writeSpatialCanvas(doc, {
        nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'hello' }],
        edges: [],
      })
      writeFacets(doc, { 'kanban/1': { status: 'todo' } })
    })
    const tool = createCanvasExportOkfTool({
      canvasDocStore,
      workspaceIndex: {} as never,
      blobStore: {} as never,
    })

    const result = await tool.execute({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID })

    expect(result.markdown.startsWith('---\n')).toBe(true)
    expect(result.markdown).toContain('hello')
    expect(result.frontmatter.facets).toEqual({ 'kanban/1': { status: 'todo' } })
  })

  test('falls back to an empty body when the canvas has no text node', async () => {
    const canvasDocStore = new FakeCanvasDocStore()
    await seed(canvasDocStore, (doc) => {
      writeSpatialCanvas(doc, {
        nodes: [{ id: 'n1', type: 'group', x: 0, y: 0, width: 100, height: 50 }],
        edges: [],
      })
    })
    const tool = createCanvasExportOkfTool({
      canvasDocStore,
      workspaceIndex: {} as never,
      blobStore: {} as never,
    })

    const result = await tool.execute({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID })

    expect(result.markdown.endsWith('---\n')).toBe(true)
  })

  test('rejects when the canvas has no stored snapshot', async () => {
    const canvasDocStore = new FakeCanvasDocStore()
    const tool = createCanvasExportOkfTool({
      canvasDocStore,
      workspaceIndex: {} as never,
      blobStore: {} as never,
    })

    await expect(tool.execute({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID })).rejects.toThrow(
      CanvasNotFoundError,
    )
  })
})
