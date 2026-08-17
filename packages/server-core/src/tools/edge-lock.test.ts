import { readEdgeLocks, writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { chunkSnapshot, reassembleSnapshot } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, test } from 'vitest'
import {
  FakeDocumentStore,
  registerDocumentInWorkspace,
} from '../test-utils/fake-document-store.js'
import { createEdgeLockTool } from './edge-lock.js'
import { EdgeNotFoundError } from './errors.js'

const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'

const CANVAS: SpatialCanvas = {
  nodes: [
    { id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'a' },
    { id: 'n2', type: 'text', x: 200, y: 0, width: 100, height: 50, text: 'b' },
  ],
  edges: [
    { id: 'e1', fromNode: 'n1', toNode: 'n2' },
    { id: 'e2', fromNode: 'n2', toNode: 'n1' },
  ],
}

async function seedCanvas(documentStore: FakeDocumentStore): Promise<void> {
  await registerDocumentInWorkspace(documentStore, WORKSPACE_ID, DOCUMENT_ID)
  const seedDoc = new LoroDoc()
  writeSpatialCanvas(seedDoc, CANVAS)
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

async function loadLocks(documentStore: FakeDocumentStore): Promise<ReadonlySet<string>> {
  const stored = await documentStore.loadSnapshot({
    docRef: { kind: 'document', documentId: DOCUMENT_ID },
  })
  if (stored === null) throw new Error('no snapshot')
  const doc = new LoroDoc()
  doc.import(reassembleSnapshot(stored.manifest, stored.chunks))
  return readEdgeLocks(doc)
}

describe('wb_edge_lock tool', () => {
  test('locks an edge and persists it, then unlocks it again', async () => {
    const documentStore = new FakeDocumentStore()
    await seedCanvas(documentStore)
    const tool = createEdgeLockTool(makeDeps(documentStore))

    const locked = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      edgeId: 'e1',
      locked: true,
    })
    expect(locked).toEqual({ documentId: DOCUMENT_ID, edgeId: 'e1', locked: true })
    expect(await loadLocks(documentStore)).toEqual(new Set(['e1']))

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      edgeId: 'e1',
      locked: false,
    })
    expect(await loadLocks(documentStore)).toEqual(new Set())
  })

  test('rejects an unknown edge id rather than creating a lock for a ghost', async () => {
    const documentStore = new FakeDocumentStore()
    await seedCanvas(documentStore)
    const tool = createEdgeLockTool(makeDeps(documentStore))

    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        edgeId: 'ghost',
        locked: true,
      }),
    ).rejects.toBeInstanceOf(EdgeNotFoundError)
    expect(await loadLocks(documentStore)).toEqual(new Set())
  })

  test('locking an already-locked edge is idempotent', async () => {
    const documentStore = new FakeDocumentStore()
    await seedCanvas(documentStore)
    const tool = createEdgeLockTool(makeDeps(documentStore))
    const input = {
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      edgeId: 'e2',
      locked: true,
    } as const

    await tool.execute(input)
    await tool.execute(input)
    expect(await loadLocks(documentStore)).toEqual(new Set(['e2']))
  })

  test('an edge lock does not lock the node with the same-shaped id', async () => {
    const documentStore = new FakeDocumentStore()
    await seedCanvas(documentStore)
    const tool = createEdgeLockTool(makeDeps(documentStore))
    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      edgeId: 'e1',
      locked: true,
    })

    const stored = await documentStore.loadSnapshot({
      docRef: { kind: 'document', documentId: DOCUMENT_ID },
    })
    const doc = new LoroDoc()
    doc.import(reassembleSnapshot(stored!.manifest, stored!.chunks))
    const { readNodeLocks } = await import('@kamiazya/whiteboard-loro-adapter')
    expect(readNodeLocks(doc)).toEqual(new Set())
  })
})
