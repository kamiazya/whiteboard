import { writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { describe, expect, test } from 'vitest'
import { FakeDocumentStore, seedDoc } from '../test-utils/fake-document-store.js'
import { ignoredDocumentWrites } from '../test-utils/ignored-document-writes.js'
import { unusedDocumentTeardown } from '../test-utils/unused-document-teardown.js'
import { SnapshotNotFoundError } from './document-io.js'
import { exportJsonCanvas } from './export-json-canvas.js'

const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'

const NODE_WITH_EXTENSION = {
  id: 'n1',
  type: 'text' as const,
  x: 0,
  y: 0,
  width: 100,
  height: 50,
  text: 'hi',
  'x-whiteboard': {
    kind: 'embed' as const,
    documentId: '01H8XJZ9K5N4M3P2Q1R0S9T8V7' as const,
  },
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

describe('exportJsonCanvas', () => {
  test('strict mode drops the x-whiteboard extension key', async () => {
    const store = new FakeDocumentStore()
    await seedDoc(store, DOCUMENT_ID, (doc) => {
      writeSpatialCanvas(doc, { nodes: [NODE_WITH_EXTENSION], edges: [] })
    })
    const result = await exportJsonCanvas(makeDeps(store), {
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      options: { strict: true },
    })
    const parsed = JSON.parse(result.json)

    expect(parsed.nodes[0]['x-whiteboard']).toBeUndefined()
  })

  test('extended mode (default) round-trips the x-whiteboard extension losslessly', async () => {
    const store = new FakeDocumentStore()
    await seedDoc(store, DOCUMENT_ID, (doc) => {
      writeSpatialCanvas(doc, { nodes: [NODE_WITH_EXTENSION], edges: [] })
    })
    const result = await exportJsonCanvas(makeDeps(store), {
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
    })
    const parsed = JSON.parse(result.json)

    expect(parsed.nodes[0]['x-whiteboard']).toEqual({
      kind: 'embed',
      documentId: '01H8XJZ9K5N4M3P2Q1R0S9T8V7',
    })
  })

  test('rejects when the canvas has no stored snapshot', async () => {
    await expect(
      exportJsonCanvas(makeDeps(new FakeDocumentStore()), {
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
      }),
    ).rejects.toThrow(SnapshotNotFoundError)
  })
})
