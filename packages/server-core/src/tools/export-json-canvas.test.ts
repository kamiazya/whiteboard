import { writeSpatialCanvas } from '@kamiazya/whiteboard-canvas-workspace'
import { describe, expect, test } from 'vitest'
import { CanvasNotFoundError } from '../render/load-spatial-canvas.js'
import { FakeCanvasDocStore, seedDoc } from '../test-utils/fake-canvas-doc-store.js'
import { exportJsonCanvas } from './export-json-canvas.js'

const CANVAS_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
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
    canvasId: '01H8XJZ9K5N4M3P2Q1R0S9T8V7' as const,
  },
}

function makeDeps(canvasDocStore: FakeCanvasDocStore) {
  return { canvasDocStore, blobStore: {} as never, documentIndex: canvasDocStore.documentIndex }
}

describe('exportJsonCanvas', () => {
  test('strict mode drops the x-whiteboard extension key', async () => {
    const store = new FakeCanvasDocStore()
    await seedDoc(store, CANVAS_ID, (doc) => {
      writeSpatialCanvas(doc, { nodes: [NODE_WITH_EXTENSION], edges: [] })
    })
    const result = await exportJsonCanvas(makeDeps(store), {
      workspaceId: WORKSPACE_ID,
      canvasId: CANVAS_ID,
      options: { strict: true },
    })
    const parsed = JSON.parse(result.json)

    expect(parsed.nodes[0]['x-whiteboard']).toBeUndefined()
  })

  test('extended mode (default) round-trips the x-whiteboard extension losslessly', async () => {
    const store = new FakeCanvasDocStore()
    await seedDoc(store, CANVAS_ID, (doc) => {
      writeSpatialCanvas(doc, { nodes: [NODE_WITH_EXTENSION], edges: [] })
    })
    const result = await exportJsonCanvas(makeDeps(store), {
      workspaceId: WORKSPACE_ID,
      canvasId: CANVAS_ID,
    })
    const parsed = JSON.parse(result.json)

    expect(parsed.nodes[0]['x-whiteboard']).toEqual({
      kind: 'embed',
      canvasId: '01H8XJZ9K5N4M3P2Q1R0S9T8V7',
    })
  })

  test('rejects when the canvas has no stored snapshot', async () => {
    await expect(
      exportJsonCanvas(makeDeps(new FakeCanvasDocStore()), {
        workspaceId: WORKSPACE_ID,
        canvasId: CANVAS_ID,
      }),
    ).rejects.toThrow(CanvasNotFoundError)
  })
})
