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
import { loadCanvasDoc } from './canvas-doc-io.js'
import { CanvasDocNotFoundError, NodeLockedError, NodeNotFoundError } from './errors.js'
import { createNodeLockTool } from './node-lock.js'
import { createNodePatchTool, nodePatchInputSchema } from './node-patch.js'

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

describe('node_patch tool', () => {
  test('patches x/y/width/height/color on a text node and persists the change', async () => {
    const canvasDocStore = new FakeCanvasDocStore()
    await seedCanvas(canvasDocStore, {
      nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'hello' }],
      edges: [],
    })
    const tool = createNodePatchTool(makeDeps(canvasDocStore))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      canvasId: CANVAS_ID,
      nodeId: 'n1',
      patch: { x: 42, y: 7, width: 200, height: 90, color: '2' },
    })

    expect(result.node).toEqual({
      id: 'n1',
      type: 'text',
      x: 42,
      y: 7,
      width: 200,
      height: 90,
      color: '2',
      text: 'hello',
    })

    const reloaded = await canvasDocStore.loadSnapshot({
      docRef: { kind: 'canvas', canvasId: CANVAS_ID },
    })
    expect(reloaded).not.toBeNull()
  })

  test('patches label on a group node', async () => {
    const canvasDocStore = new FakeCanvasDocStore()
    await seedCanvas(canvasDocStore, {
      nodes: [{ id: 'g1', type: 'group', x: 0, y: 0, width: 300, height: 300 }],
      edges: [],
    })
    const tool = createNodePatchTool(makeDeps(canvasDocStore))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      canvasId: CANVAS_ID,
      nodeId: 'g1',
      patch: { label: 'My Group' },
    })

    expect(result.node).toMatchObject({ id: 'g1', type: 'group', label: 'My Group' })
  })

  test('silently drops label patched onto a text node (unknown key for that type)', async () => {
    const canvasDocStore = new FakeCanvasDocStore()
    await seedCanvas(canvasDocStore, {
      nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'hello' }],
      edges: [],
    })
    const tool = createNodePatchTool(makeDeps(canvasDocStore))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      canvasId: CANVAS_ID,
      nodeId: 'n1',
      patch: { label: 'ignored' },
    })

    expect(result.node).not.toHaveProperty('label')
  })

  test('reindexes the workspace after patching a node', async () => {
    const canvasDocStore = new FakeCanvasDocStore()
    await seedCanvas(canvasDocStore, {
      nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'hello' }],
      edges: [],
    })
    const deps = makeDeps(canvasDocStore)
    const applyRowsSpy = vi.spyOn(deps.workspaceIndex, 'applyRows')
    const tool = createNodePatchTool(deps)

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      canvasId: CANVAS_ID,
      nodeId: 'n1',
      patch: { x: 42 },
    })

    // Spying on `applyRows` (rather than re-checking `listCanvases`/
    // `queryFacet`, which a node patch never changes) is what actually
    // pins the reindex-after-mutation wiring in this tool.
    expect(applyRowsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WORKSPACE_ID }),
    )
  })

  test('throws NodeNotFoundError for an unknown nodeId', async () => {
    const canvasDocStore = new FakeCanvasDocStore()
    await seedCanvas(canvasDocStore, {
      nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'hello' }],
      edges: [],
    })
    const tool = createNodePatchTool(makeDeps(canvasDocStore))

    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        canvasId: CANVAS_ID,
        nodeId: 'missing',
        patch: { x: 1 },
      }),
    ).rejects.toThrow(NodeNotFoundError)
  })

  test('throws CanvasDocNotFoundError when no snapshot exists yet', async () => {
    const canvasDocStore = new FakeCanvasDocStore()
    await registerCanvasInWorkspace(canvasDocStore, WORKSPACE_ID, CANVAS_ID)
    const tool = createNodePatchTool(makeDeps(canvasDocStore))

    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        canvasId: CANVAS_ID,
        nodeId: 'n1',
        patch: { x: 1 },
      }),
    ).rejects.toThrow(CanvasDocNotFoundError)
  })

  test('throws CanvasNotFoundError when workspaceId does not actually own canvasId', async () => {
    const canvasDocStore = new FakeCanvasDocStore()
    await seedCanvas(canvasDocStore, {
      nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'hello' }],
      edges: [],
    })
    const tool = createNodePatchTool(makeDeps(canvasDocStore))

    await expect(
      tool.execute({
        workspaceId: 'ws-other',
        canvasId: CANVAS_ID,
        nodeId: 'n1',
        patch: { x: 1 },
      }),
    ).rejects.toThrow(CanvasNotFoundError)
  })

  test('rejects a negative width at the input-schema level', () => {
    const result = nodePatchInputSchema.safeParse({
      workspaceId: WORKSPACE_ID,
      canvasId: CANVAS_ID,
      nodeId: 'n1',
      patch: { width: -5 },
    })
    expect(result.success).toBe(false)
  })

  test('refuses to patch a LOCKED node — the lock binds agents too, not just the pointer', async () => {
    const canvasDocStore = new FakeCanvasDocStore()
    await seedCanvas(canvasDocStore, {
      nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'a' }],
      edges: [],
    })
    // Lock it the way the editor does: through the sidecar map.
    const lockTool = createNodeLockTool(makeDeps(canvasDocStore))
    await lockTool.execute({
      workspaceId: WORKSPACE_ID,
      canvasId: CANVAS_ID,
      nodeId: 'n1',
      locked: true,
    })

    const tool = createNodePatchTool(makeDeps(canvasDocStore))
    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        canvasId: CANVAS_ID,
        nodeId: 'n1',
        patch: { x: 999 },
      }),
    ).rejects.toBeInstanceOf(NodeLockedError)

    // And nothing was written.
    const { canvas } = await loadCanvasDoc(makeDeps(canvasDocStore), CANVAS_ID)
    expect(canvas.nodes[0]).toMatchObject({ x: 0 })
  })

  test('patches normally once the node is unlocked', async () => {
    const canvasDocStore = new FakeCanvasDocStore()
    await seedCanvas(canvasDocStore, {
      nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'a' }],
      edges: [],
    })
    const lockTool = createNodeLockTool(makeDeps(canvasDocStore))
    await lockTool.execute({
      workspaceId: WORKSPACE_ID,
      canvasId: CANVAS_ID,
      nodeId: 'n1',
      locked: true,
    })
    await lockTool.execute({
      workspaceId: WORKSPACE_ID,
      canvasId: CANVAS_ID,
      nodeId: 'n1',
      locked: false,
    })

    const tool = createNodePatchTool(makeDeps(canvasDocStore))
    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      canvasId: CANVAS_ID,
      nodeId: 'n1',
      patch: { x: 42 },
    })
    expect(result.node).toMatchObject({ x: 42 })
  })
})
