import { writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { chunkSnapshot } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, test } from 'vitest'
import {
  FakeDocumentStore,
  registerDocumentInWorkspace,
} from '../test-utils/fake-document-store.js'
import { ignoredDocumentWrites } from '../test-utils/ignored-document-writes.js'
import { unusedDocumentTeardown } from '../test-utils/unused-document-teardown.js'
import { createBodyPatchTool } from './body-patch.js'
import { WorkspaceDocumentNotFoundError } from './document-crud.errors.js'
import { NodeNotFoundError, NotATextNodeError, PatchValidationError } from './errors.js'

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
  return {
    documentStore,
    blobStore: {} as never,
    documentIndex: documentStore.documentIndex,
    documentTeardown: unusedDocumentTeardown(),
    documentWritten: ignoredDocumentWrites(),
  }
}

describe('wb_body_patch tool', () => {
  test('mode "full" replaces the entire text body', async () => {
    const documentStore = new FakeDocumentStore()
    await seedCanvas(documentStore, {
      nodes: [{ id: 't1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'line1\nline2' }],
      edges: [],
    })
    const tool = createBodyPatchTool(makeDeps(documentStore))

    const result = await tool.execute({
      mode: 'full',
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      nodeId: 't1',
      body: 'replaced',
    })

    expect(result.node).toMatchObject({ id: 't1', type: 'text', text: 'replaced' })
  })

  test('mode "range" splices a subset of lines, preserving lines outside the range', async () => {
    const documentStore = new FakeDocumentStore()
    await seedCanvas(documentStore, {
      nodes: [
        {
          id: 't1',
          type: 'text',
          x: 0,
          y: 0,
          width: 100,
          height: 50,
          text: 'line0\nline1\nline2\nline3',
        },
      ],
      edges: [],
    })
    const tool = createBodyPatchTool(makeDeps(documentStore))

    const result = await tool.execute({
      mode: 'range',
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      nodeId: 't1',
      range: { startLine: 1, endLine: 2, replacement: 'NEW' },
    })

    expect(result.node).toMatchObject({ id: 't1', type: 'text', text: 'line0\nNEW\nline3' })
  })

  test('throws NotATextNodeError when targeting a non-text node', async () => {
    const documentStore = new FakeDocumentStore()
    await seedCanvas(documentStore, {
      nodes: [{ id: 'g1', type: 'group', x: 0, y: 0, width: 100, height: 50 }],
      edges: [],
    })
    const tool = createBodyPatchTool(makeDeps(documentStore))

    await expect(
      tool.execute({
        mode: 'full',
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        nodeId: 'g1',
        body: 'x',
      }),
    ).rejects.toThrow(NotATextNodeError)
  })

  test('throws PatchValidationError for an out-of-range line splice', async () => {
    const documentStore = new FakeDocumentStore()
    await seedCanvas(documentStore, {
      nodes: [
        { id: 't1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'only-one-line' },
      ],
      edges: [],
    })
    const tool = createBodyPatchTool(makeDeps(documentStore))

    await expect(
      tool.execute({
        mode: 'range',
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        nodeId: 't1',
        range: { startLine: 0, endLine: 5, replacement: 'x' },
      }),
    ).rejects.toThrow(PatchValidationError)
  })

  test('throws NodeNotFoundError for an unknown nodeId', async () => {
    const documentStore = new FakeDocumentStore()
    await seedCanvas(documentStore, {
      nodes: [{ id: 't1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'x' }],
      edges: [],
    })
    const tool = createBodyPatchTool(makeDeps(documentStore))

    await expect(
      tool.execute({
        mode: 'full',
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        nodeId: 'missing',
        body: 'x',
      }),
    ).rejects.toThrow(NodeNotFoundError)
  })

  test('throws WorkspaceDocumentNotFoundError when workspaceId does not actually own documentId', async () => {
    const documentStore = new FakeDocumentStore()
    await seedCanvas(documentStore, {
      nodes: [{ id: 't1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'x' }],
      edges: [],
    })
    const tool = createBodyPatchTool(makeDeps(documentStore))

    await expect(
      tool.execute({
        mode: 'full',
        workspaceId: 'ws-other',
        documentId: DOCUMENT_ID,
        nodeId: 't1',
        body: 'x',
      }),
    ).rejects.toThrow(WorkspaceDocumentNotFoundError)
  })
})
