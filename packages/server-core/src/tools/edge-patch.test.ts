import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { chunkSnapshot } from '@kamiazya/whiteboard-canvas-ports'
import { writeSpatialCanvas } from '@kamiazya/whiteboard-canvas-workspace'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, test, vi } from 'vitest'
import {
  FakeCanvasDocStore,
  registerCanvasInWorkspace,
} from '../test-utils/fake-canvas-doc-store.js'
import { createInMemoryWorkspaceIndex } from '../test-utils/in-memory-workspace-index.js'
import { CanvasNotFoundError } from './canvas-crud.errors.js'
import { createEdgePatchTool, edgePatchFieldsSchema } from './edge-patch.js'
import { EdgeNotFoundError, PatchValidationError } from './errors.js'

const CANVAS_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'

async function seedCanvas(
  canvasDocStore: FakeCanvasDocStore,
  canvas: SpatialCanvas,
): Promise<void> {
  await registerCanvasInWorkspace(canvasDocStore, WORKSPACE_ID, CANVAS_ID)
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
  return { canvasDocStore, workspaceIndex: createInMemoryWorkspaceIndex(), blobStore: {} as never }
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
      workspaceId: WORKSPACE_ID,
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

  test('the patch schema accepts fromEnd/toEnd and rejects invalid ends', () => {
    // The tool's execute is schema-gated at the MCP layer, so the SCHEMA is
    // the contract that must admit ends — a strict schema without them
    // silently locked agents out of arrowheads.
    expect(edgePatchFieldsSchema.safeParse({ fromEnd: 'arrow', toEnd: 'none' }).success).toBe(true)
    expect(edgePatchFieldsSchema.safeParse({ toEnd: 'diamond' }).success).toBe(false)
  })

  test('patches fromEnd/toEnd so an agent can restyle arrowheads', async () => {
    const canvasDocStore = new FakeCanvasDocStore()
    await seedCanvas(canvasDocStore, BASE_CANVAS)
    const tool = createEdgePatchTool(makeDeps(canvasDocStore))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      canvasId: CANVAS_ID,
      edgeId: 'e1',
      patch: { fromEnd: 'arrow', toEnd: 'none' },
    })

    expect(result.edge).toEqual({
      id: 'e1',
      fromNode: 'n1',
      toNode: 'n2',
      fromEnd: 'arrow',
      toEnd: 'none',
    })
  })

  test('reindexes the workspace after patching an edge', async () => {
    const canvasDocStore = new FakeCanvasDocStore()
    await seedCanvas(canvasDocStore, BASE_CANVAS)
    const deps = makeDeps(canvasDocStore)
    const applyRowsSpy = vi.spyOn(deps.workspaceIndex, 'applyRows')
    const tool = createEdgePatchTool(deps)

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      canvasId: CANVAS_ID,
      edgeId: 'e1',
      patch: { color: '3' },
    })

    // Spying on `applyRows` (rather than re-checking `listCanvases`/
    // `queryFacet`, which an edge patch never changes) is what actually
    // pins the reindex-after-mutation wiring in this tool.
    expect(applyRowsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WORKSPACE_ID }),
    )
  })

  test('throws EdgeNotFoundError for an unknown edgeId', async () => {
    const canvasDocStore = new FakeCanvasDocStore()
    await seedCanvas(canvasDocStore, BASE_CANVAS)
    const tool = createEdgePatchTool(makeDeps(canvasDocStore))

    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        canvasId: CANVAS_ID,
        edgeId: 'missing',
        patch: { color: '1' },
      }),
    ).rejects.toThrow(EdgeNotFoundError)
  })

  test('retargeting toNode to a nonexistent node id throws PatchValidationError', async () => {
    const canvasDocStore = new FakeCanvasDocStore()
    await seedCanvas(canvasDocStore, BASE_CANVAS)
    const tool = createEdgePatchTool(makeDeps(canvasDocStore))

    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        canvasId: CANVAS_ID,
        edgeId: 'e1',
        patch: { toNode: 'does-not-exist' },
      }),
    ).rejects.toThrow(PatchValidationError)
  })

  test('throws CanvasNotFoundError when workspaceId does not actually own canvasId', async () => {
    const canvasDocStore = new FakeCanvasDocStore()
    await seedCanvas(canvasDocStore, BASE_CANVAS)
    const tool = createEdgePatchTool(makeDeps(canvasDocStore))

    await expect(
      tool.execute({
        workspaceId: 'ws-other',
        canvasId: CANVAS_ID,
        edgeId: 'e1',
        patch: { color: '1' },
      }),
    ).rejects.toThrow(CanvasNotFoundError)
  })
})
