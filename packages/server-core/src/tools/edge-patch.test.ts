import { writeSpatialCanvas } from '@kamiazya/whiteboard-crdt'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { chunkSnapshot } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, test } from 'vitest'
import { FakeDocumentStore, registerCanvasInWorkspace } from '../test-utils/fake-document-store.js'
import { CanvasNotFoundError } from './canvas-crud.errors.js'
import { loadDocument } from './document-io.js'
import { createEdgeLockTool } from './edge-lock.js'
import { createEdgePatchTool, edgePatchFieldsSchema } from './edge-patch.js'
import { EdgeLockedError, EdgeNotFoundError, PatchValidationError } from './errors.js'

const CANVAS_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'

async function seedCanvas(documentStore: FakeDocumentStore, canvas: SpatialCanvas): Promise<void> {
  await registerCanvasInWorkspace(documentStore, WORKSPACE_ID, CANVAS_ID)
  const seedDoc = new LoroDoc()
  writeSpatialCanvas(seedDoc, canvas)
  const { manifest, chunks } = chunkSnapshot(seedDoc.export({ mode: 'snapshot' }), 1_000_000)
  await documentStore.saveSnapshot({
    docRef: { kind: 'canvas', documentId: CANVAS_ID },
    manifest,
    chunks,
    frontier: seedDoc.oplogVersion().encode() as Uint8Array<ArrayBuffer>,
  })
}

function makeDeps(documentStore: FakeDocumentStore) {
  return { documentStore, blobStore: {} as never, documentIndex: documentStore.documentIndex }
}

const BASE_CANVAS: SpatialCanvas = {
  nodes: [
    { id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'a' },
    { id: 'n2', type: 'text', x: 200, y: 0, width: 100, height: 50, text: 'b' },
  ],
  edges: [{ id: 'e1', fromNode: 'n1', toNode: 'n2' }],
}

describe('wb_edge_patch tool', () => {
  test('patches color/label/fromSide/toSide on an existing edge', async () => {
    const documentStore = new FakeDocumentStore()
    await seedCanvas(documentStore, BASE_CANVAS)
    const tool = createEdgePatchTool(makeDeps(documentStore))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: CANVAS_ID,
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
    const documentStore = new FakeDocumentStore()
    await seedCanvas(documentStore, BASE_CANVAS)
    const tool = createEdgePatchTool(makeDeps(documentStore))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: CANVAS_ID,
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

  test('throws EdgeNotFoundError for an unknown edgeId', async () => {
    const documentStore = new FakeDocumentStore()
    await seedCanvas(documentStore, BASE_CANVAS)
    const tool = createEdgePatchTool(makeDeps(documentStore))

    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: CANVAS_ID,
        edgeId: 'missing',
        patch: { color: '1' },
      }),
    ).rejects.toThrow(EdgeNotFoundError)
  })

  test('retargeting toNode to a nonexistent node id throws PatchValidationError', async () => {
    const documentStore = new FakeDocumentStore()
    await seedCanvas(documentStore, BASE_CANVAS)
    const tool = createEdgePatchTool(makeDeps(documentStore))

    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: CANVAS_ID,
        edgeId: 'e1',
        patch: { toNode: 'does-not-exist' },
      }),
    ).rejects.toThrow(PatchValidationError)
  })

  test('throws CanvasNotFoundError when workspaceId does not actually own documentId', async () => {
    const documentStore = new FakeDocumentStore()
    await seedCanvas(documentStore, BASE_CANVAS)
    const tool = createEdgePatchTool(makeDeps(documentStore))

    await expect(
      tool.execute({
        workspaceId: 'ws-other',
        documentId: CANVAS_ID,
        edgeId: 'e1',
        patch: { color: '1' },
      }),
    ).rejects.toThrow(CanvasNotFoundError)
  })

  test('refuses to patch a LOCKED edge — the lock binds agents too, not just the pointer', async () => {
    const documentStore = new FakeDocumentStore()
    await seedCanvas(documentStore, BASE_CANVAS)
    // Lock it the way the editor does: through the sidecar map.
    const lockTool = createEdgeLockTool(makeDeps(documentStore))
    await lockTool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: CANVAS_ID,
      edgeId: 'e1',
      locked: true,
    })

    const tool = createEdgePatchTool(makeDeps(documentStore))
    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: CANVAS_ID,
        edgeId: 'e1',
        patch: { label: 'rewritten' },
      }),
    ).rejects.toBeInstanceOf(EdgeLockedError)

    const { canvas } = await loadDocument(makeDeps(documentStore), CANVAS_ID)
    expect(canvas.edges[0].label).toBeUndefined()
  })

  test('patches normally once the edge is unlocked', async () => {
    const documentStore = new FakeDocumentStore()
    await seedCanvas(documentStore, BASE_CANVAS)
    const lockTool = createEdgeLockTool(makeDeps(documentStore))
    await lockTool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: CANVAS_ID,
      edgeId: 'e1',
      locked: true,
    })
    await lockTool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: CANVAS_ID,
      edgeId: 'e1',
      locked: false,
    })

    const tool = createEdgePatchTool(makeDeps(documentStore))
    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: CANVAS_ID,
      edgeId: 'e1',
      patch: { label: 'now editable' },
    })
    expect(result.edge).toMatchObject({ label: 'now editable' })
  })

  test('a locked NODE does not block patching an edge that touches it', async () => {
    const documentStore = new FakeDocumentStore()
    await seedCanvas(documentStore, BASE_CANVAS)
    const { createNodeLockTool } = await import('./node-lock.js')
    await createNodeLockTool(makeDeps(documentStore)).execute({
      workspaceId: WORKSPACE_ID,
      documentId: CANVAS_ID,
      nodeId: 'n1',
      locked: true,
    })

    // Edge locks are their own set: locking a hub node must not silently
    // freeze every line touching it.
    const result = await createEdgePatchTool(makeDeps(documentStore)).execute({
      workspaceId: WORKSPACE_ID,
      documentId: CANVAS_ID,
      edgeId: 'e1',
      patch: { color: '2' },
    })
    expect(result.edge).toMatchObject({ color: '2' })
  })
})
