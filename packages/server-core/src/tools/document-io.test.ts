import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { describe, expect, test } from 'vitest'
import { FakeDocumentStore } from '../test-utils/fake-document-store.js'
import { unusedDocumentIndex } from '../test-utils/unused-document-index.js'
import { loadDocument, saveCanvasDoc } from './document-io.js'
import { DocumentNotFoundError } from './errors.js'

const CANVAS_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'

const canvasDeps = (documentStore: FakeDocumentStore) => ({
  documentStore,
  blobStore: {} as never,
  documentIndex: unusedDocumentIndex(),
})

describe('document-io', () => {
  test('loadDocument throws DocumentNotFoundError when no snapshot exists', async () => {
    const documentStore = new FakeDocumentStore()
    await expect(loadDocument(canvasDeps(documentStore), CANVAS_ID)).rejects.toThrow(
      DocumentNotFoundError,
    )
  })

  test('save then load round trip preserves nodes untouched by the patch', async () => {
    const documentStore = new FakeDocumentStore()
    const deps = canvasDeps(documentStore)

    const canvas: SpatialCanvas = {
      nodes: [
        { id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'hello' },
        { id: 'n2', type: 'text', x: 10, y: 10, width: 100, height: 50, text: 'world' },
      ],
      edges: [],
    }

    // Seed the store directly (bypassing the tool under test).
    const { LoroDoc } = await import('loro-crdt')
    const { writeSpatialCanvas } = await import('@kamiazya/whiteboard-canvas-workspace')
    const { chunkSnapshot } = await import('@kamiazya/whiteboard-canvas-ports')
    const seedDoc = new LoroDoc()
    writeSpatialCanvas(seedDoc, canvas)
    const { manifest, chunks } = chunkSnapshot(seedDoc.export({ mode: 'snapshot' }), 1_000_000)
    await documentStore.saveSnapshot({
      docRef: { kind: 'canvas', canvasId: CANVAS_ID },
      manifest,
      chunks,
      frontier: seedDoc.oplogVersion().encode() as Uint8Array<ArrayBuffer>,
    })

    const loaded = await loadDocument(deps, CANVAS_ID)
    expect(loaded.canvas.nodes).toHaveLength(2)

    // Simulate a patch that only touches n1, passing the FULL node array back.
    const patched: SpatialCanvas = {
      nodes: loaded.canvas.nodes.map((node) => (node.id === 'n1' ? { ...node, x: 99 } : node)),
      edges: loaded.canvas.edges,
    }
    await saveCanvasDoc(deps, CANVAS_ID, loaded.doc, patched)

    const reloaded = await loadDocument(deps, CANVAS_ID)
    expect(reloaded.canvas.nodes).toHaveLength(2)
    const n2 = reloaded.canvas.nodes.find((node) => node.id === 'n2')
    expect(n2).toEqual(canvas.nodes[1])
  })
})
