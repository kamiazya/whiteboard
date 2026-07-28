import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { chunkSnapshot } from '@kamiazya/whiteboard-canvas-ports'
import { writeSpatialCanvas } from '@kamiazya/whiteboard-canvas-workspace'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, test } from 'vitest'
import { FakeCanvasDocStore } from '../test-utils/fake-canvas-doc-store.js'
import { createEdgePatchTool } from './edge-patch.js'
import { EdgeNotFoundError, PatchValidationError } from './errors.js'

const CANVAS_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'

async function seedCanvas(
  canvasDocStore: FakeCanvasDocStore,
  canvas: SpatialCanvas,
): Promise<void> {
  const seedDoc = new LoroDoc()
  writeSpatialCanvas(seedDoc, canvas)
  const { manifest, chunks } = chunkSnapshot(seedDoc.export({ mode: 'snapshot' }), 1_000_000)
  await canvasDocStore.saveSnapshot({
    docRef: { kind: 'canvas', canvasId: CANVAS_ID },
    manifest,
    chunks,
    frontier: seedDoc.oplogVersion().encode() as Uint8Array<ArrayBuffer>,
  })
}

function makeDeps(canvasDocStore: FakeCanvasDocStore) {
  return { canvasDocStore, workspaceIndex: {} as never, blobStore: {} as never }
}

const BASE_CANVAS: SpatialCanvas = {
  nodes: [
    { id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'a' },
    { id: 'n2', type: 'text', x: 200, y: 0, width: 100, height: 50, text: 'b' },
  ],
  edges: [{ id: 'e1', fromNode: 'n1', toNode: 'n2' }],
}

describe('edge_patch tool', () => {
  test('patches color/label/fromSide/toSide on an existing edge', async () => {
    const canvasDocStore = new FakeCanvasDocStore()
    await seedCanvas(canvasDocStore, BASE_CANVAS)
    const tool = createEdgePatchTool(makeDeps(canvasDocStore))

    const result = await tool.execute({
      canvasId: CANVAS_ID,
      edgeId: 'e1',
      patch: { color: '3', label: 'connects', fromSide: 'right', toSide: 'left' },
    })

    expect(result.edge).toEqual({
      id: 'e1',
      fromNode: 'n1',
      toNode: 'n2',
      color: '3',
      label: 'connects',
      fromSide: 'right',
      toSide: 'left',
    })
  })

  test('throws EdgeNotFoundError for an unknown edgeId', async () => {
    const canvasDocStore = new FakeCanvasDocStore()
    await seedCanvas(canvasDocStore, BASE_CANVAS)
    const tool = createEdgePatchTool(makeDeps(canvasDocStore))

    await expect(
      tool.execute({ canvasId: CANVAS_ID, edgeId: 'missing', patch: { color: '1' } }),
    ).rejects.toThrow(EdgeNotFoundError)
  })

  test('retargeting toNode to a nonexistent node id throws PatchValidationError', async () => {
    const canvasDocStore = new FakeCanvasDocStore()
    await seedCanvas(canvasDocStore, BASE_CANVAS)
    const tool = createEdgePatchTool(makeDeps(canvasDocStore))

    await expect(
      tool.execute({ canvasId: CANVAS_ID, edgeId: 'e1', patch: { toNode: 'does-not-exist' } }),
    ).rejects.toThrow(PatchValidationError)
  })
})
