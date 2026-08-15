import { writeSpatialCanvas } from '@kamiazya/whiteboard-canvas-workspace'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, test } from 'vitest'
import { FakeCanvasDocStore, seedDoc } from '../test-utils/fake-canvas-doc-store.js'
import { unusedDocumentIndex } from '../test-utils/unused-document-index.js'
import { CanvasNotFoundError, loadSpatialCanvas } from './load-spatial-canvas.js'

const CANVAS_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'

describe('loadSpatialCanvas', () => {
  test('throws CanvasNotFoundError when no snapshot exists', async () => {
    const canvasDocStore = new FakeCanvasDocStore()
    const deps = { canvasDocStore, blobStore: {} as never, documentIndex: unusedDocumentIndex() }

    await expect(loadSpatialCanvas(deps, CANVAS_ID)).rejects.toThrow(CanvasNotFoundError)
  })

  test('returns the doc and decoded canvas for an existing snapshot', async () => {
    const canvasDocStore = new FakeCanvasDocStore()
    await seedDoc(canvasDocStore, CANVAS_ID, (doc) => {
      writeSpatialCanvas(doc, {
        nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'hello' }],
        edges: [],
      })
    })

    const deps = { canvasDocStore, blobStore: {} as never, documentIndex: unusedDocumentIndex() }
    const { doc, canvas } = await loadSpatialCanvas(deps, CANVAS_ID)

    expect(doc).toBeInstanceOf(LoroDoc)
    expect(canvas.nodes).toEqual([
      { id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'hello' },
    ])
  })
})
