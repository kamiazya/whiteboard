import { writeSpatialCanvas } from '@kamiazya/whiteboard-crdt'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, test } from 'vitest'
import { FakeDocumentStore, seedDoc } from '../test-utils/fake-document-store.js'
import { unusedDocumentIndex } from '../test-utils/unused-document-index.js'
import { CanvasNotFoundError, loadSpatialCanvas } from './load-spatial-canvas.js'

const CANVAS_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'

describe('loadSpatialCanvas', () => {
  test('throws CanvasNotFoundError when no snapshot exists', async () => {
    const documentStore = new FakeDocumentStore()
    const deps = { documentStore, blobStore: {} as never, documentIndex: unusedDocumentIndex() }

    await expect(loadSpatialCanvas(deps, CANVAS_ID)).rejects.toThrow(CanvasNotFoundError)
  })

  test('returns the doc and decoded canvas for an existing snapshot', async () => {
    const documentStore = new FakeDocumentStore()
    await seedDoc(documentStore, CANVAS_ID, (doc) => {
      writeSpatialCanvas(doc, {
        nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'hello' }],
        edges: [],
      })
    })

    const deps = { documentStore, blobStore: {} as never, documentIndex: unusedDocumentIndex() }
    const { doc, canvas } = await loadSpatialCanvas(deps, CANVAS_ID)

    expect(doc).toBeInstanceOf(LoroDoc)
    expect(canvas.nodes).toEqual([
      { id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'hello' },
    ])
  })
})
