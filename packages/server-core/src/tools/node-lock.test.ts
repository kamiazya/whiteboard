import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { chunkSnapshot, reassembleSnapshot } from '@kamiazya/whiteboard-canvas-ports'
import { readNodeLocks, writeSpatialCanvas } from '@kamiazya/whiteboard-canvas-workspace'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, test } from 'vitest'
import { FakeDocumentStore, registerCanvasInWorkspace } from '../test-utils/fake-document-store.js'
import { NodeNotFoundError } from './errors.js'
import { createNodeLockTool } from './node-lock.js'

const CANVAS_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'

const CANVAS: SpatialCanvas = {
  nodes: [
    { id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'a' },
    { id: 'n2', type: 'text', x: 200, y: 0, width: 100, height: 50, text: 'b' },
  ],
  edges: [],
}

async function seedCanvas(documentStore: FakeDocumentStore): Promise<void> {
  await registerCanvasInWorkspace(documentStore, WORKSPACE_ID, CANVAS_ID)
  const seedDoc = new LoroDoc()
  writeSpatialCanvas(seedDoc, CANVAS)
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

async function loadLocks(documentStore: FakeDocumentStore): Promise<ReadonlySet<string>> {
  const stored = await documentStore.loadSnapshot({
    docRef: { kind: 'canvas', documentId: CANVAS_ID },
  })
  if (stored === null) throw new Error('no snapshot')
  const doc = new LoroDoc()
  doc.import(reassembleSnapshot(stored.manifest, stored.chunks))
  return readNodeLocks(doc)
}

describe('wb_node_lock tool', () => {
  test('locks a node and persists it, then unlocks it again', async () => {
    const documentStore = new FakeDocumentStore()
    await seedCanvas(documentStore)
    const tool = createNodeLockTool(makeDeps(documentStore))

    const locked = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: CANVAS_ID,
      nodeId: 'n1',
      locked: true,
    })
    expect(locked).toEqual({ documentId: CANVAS_ID, nodeId: 'n1', locked: true })
    expect(await loadLocks(documentStore)).toEqual(new Set(['n1']))

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: CANVAS_ID,
      nodeId: 'n1',
      locked: false,
    })
    expect(await loadLocks(documentStore)).toEqual(new Set())
  })

  test('rejects an unknown node id rather than creating a lock for a ghost', async () => {
    const documentStore = new FakeDocumentStore()
    await seedCanvas(documentStore)
    const tool = createNodeLockTool(makeDeps(documentStore))

    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: CANVAS_ID,
        nodeId: 'ghost',
        locked: true,
      }),
    ).rejects.toBeInstanceOf(NodeNotFoundError)
    expect(await loadLocks(documentStore)).toEqual(new Set())
  })

  test('locking an already-locked node is idempotent', async () => {
    const documentStore = new FakeDocumentStore()
    await seedCanvas(documentStore)
    const tool = createNodeLockTool(makeDeps(documentStore))
    const input = {
      workspaceId: WORKSPACE_ID,
      documentId: CANVAS_ID,
      nodeId: 'n2',
      locked: true,
    } as const

    await tool.execute(input)
    await tool.execute(input)
    expect(await loadLocks(documentStore)).toEqual(new Set(['n2']))
  })
})
