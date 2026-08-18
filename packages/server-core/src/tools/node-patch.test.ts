import { writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { chunkSnapshot } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, test } from 'vitest'
import {
  FakeDocumentStore,
  registerDocumentInWorkspace,
} from '../test-utils/fake-document-store.js'
import { WorkspaceDocumentNotFoundError } from './document-crud.errors.js'
import { loadDocument, SnapshotNotFoundError } from './document-io.js'
import { NodeLockedError, NodeNotFoundError } from './errors.js'
import { createNodeLockTool } from './node-lock.js'
import { createNodePatchTool, nodePatchInputSchema } from './node-patch.js'

const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'

async function seedCanvas(documentStore: FakeDocumentStore, canvas: SpatialCanvas): Promise<void> {
  await registerDocumentInWorkspace(documentStore, WORKSPACE_ID, DOCUMENT_ID)
  const seedDoc = new LoroDoc()
  writeSpatialCanvas(seedDoc, canvas)
  const { manifest, chunks } = chunkSnapshot(seedDoc.export({ mode: 'snapshot' }), 1_000_000)
  await documentStore.saveSnapshot({
    docRef: { kind: 'document', documentId: DOCUMENT_ID },
    manifest,
    chunks,
    frontier: seedDoc.oplogVersion().encode() as Uint8Array<ArrayBuffer>,
  })
}

function makeDeps(documentStore: FakeDocumentStore) {
  return { documentStore, blobStore: {} as never, documentIndex: documentStore.documentIndex }
}

describe('wb_node_patch tool', () => {
  test('patches x/y/width/height/color on a text node and persists the change', async () => {
    const documentStore = new FakeDocumentStore()
    await seedCanvas(documentStore, {
      nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'hello' }],
      edges: [],
    })
    const tool = createNodePatchTool(makeDeps(documentStore))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
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

    const reloaded = await documentStore.loadSnapshot({
      docRef: { kind: 'document', documentId: DOCUMENT_ID },
    })
    expect(reloaded).not.toBeNull()
  })

  test('patches label on a group node', async () => {
    const documentStore = new FakeDocumentStore()
    await seedCanvas(documentStore, {
      nodes: [{ id: 'g1', type: 'group', x: 0, y: 0, width: 300, height: 300 }],
      edges: [],
    })
    const tool = createNodePatchTool(makeDeps(documentStore))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      nodeId: 'g1',
      patch: { label: 'My Group' },
    })

    expect(result.node).toMatchObject({ id: 'g1', type: 'group', label: 'My Group' })
  })

  test('silently drops label patched onto a text node (unknown key for that type)', async () => {
    const documentStore = new FakeDocumentStore()
    await seedCanvas(documentStore, {
      nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'hello' }],
      edges: [],
    })
    const tool = createNodePatchTool(makeDeps(documentStore))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      nodeId: 'n1',
      patch: { label: 'ignored' },
    })

    expect(result.node).not.toHaveProperty('label')
  })

  test('throws NodeNotFoundError for an unknown nodeId', async () => {
    const documentStore = new FakeDocumentStore()
    await seedCanvas(documentStore, {
      nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'hello' }],
      edges: [],
    })
    const tool = createNodePatchTool(makeDeps(documentStore))

    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        nodeId: 'missing',
        patch: { x: 1 },
      }),
    ).rejects.toThrow(NodeNotFoundError)
  })

  test('throws SnapshotNotFoundError when no snapshot exists yet', async () => {
    const documentStore = new FakeDocumentStore()
    await registerDocumentInWorkspace(documentStore, WORKSPACE_ID, DOCUMENT_ID)
    const tool = createNodePatchTool(makeDeps(documentStore))

    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        nodeId: 'n1',
        patch: { x: 1 },
      }),
    ).rejects.toThrow(SnapshotNotFoundError)
  })

  test('throws WorkspaceDocumentNotFoundError when workspaceId does not actually own documentId', async () => {
    const documentStore = new FakeDocumentStore()
    await seedCanvas(documentStore, {
      nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'hello' }],
      edges: [],
    })
    const tool = createNodePatchTool(makeDeps(documentStore))

    await expect(
      tool.execute({
        workspaceId: 'ws-other',
        documentId: DOCUMENT_ID,
        nodeId: 'n1',
        patch: { x: 1 },
      }),
    ).rejects.toThrow(WorkspaceDocumentNotFoundError)
  })

  test('rejects a negative width at the input-schema level', () => {
    const result = nodePatchInputSchema.safeParse({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      nodeId: 'n1',
      patch: { width: -5 },
    })
    expect(result.success).toBe(false)
  })

  test('refuses to patch a LOCKED node — the lock binds agents too, not just the pointer', async () => {
    const documentStore = new FakeDocumentStore()
    await seedCanvas(documentStore, {
      nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'a' }],
      edges: [],
    })
    // Lock it the way the editor does: through the sidecar map.
    const lockTool = createNodeLockTool(makeDeps(documentStore))
    await lockTool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      nodeId: 'n1',
      locked: true,
    })

    const tool = createNodePatchTool(makeDeps(documentStore))
    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        nodeId: 'n1',
        patch: { x: 999 },
      }),
    ).rejects.toBeInstanceOf(NodeLockedError)

    // And nothing was written.
    const { canvas } = await loadDocument(makeDeps(documentStore), DOCUMENT_ID)
    expect(canvas.nodes[0]).toMatchObject({ x: 0 })
  })

  test('patches normally once the node is unlocked', async () => {
    const documentStore = new FakeDocumentStore()
    await seedCanvas(documentStore, {
      nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'a' }],
      edges: [],
    })
    const lockTool = createNodeLockTool(makeDeps(documentStore))
    await lockTool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      nodeId: 'n1',
      locked: true,
    })
    await lockTool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      nodeId: 'n1',
      locked: false,
    })

    const tool = createNodePatchTool(makeDeps(documentStore))
    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      nodeId: 'n1',
      patch: { x: 42 },
    })
    expect(result.node).toMatchObject({ x: 42 })
  })
})
