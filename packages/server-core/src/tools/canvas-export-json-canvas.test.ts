import { writeSpatialCanvas } from '@kamiazya/whiteboard-canvas-workspace'
import { describe, expect, test } from 'vitest'
import { CanvasNotFoundError } from '../render/load-spatial-canvas.js'
import { FakeCanvasDocStore, seedDoc } from '../test-utils/fake-canvas-doc-store.js'
import { createCanvasExportJsonCanvasTool } from './canvas-export-json-canvas.js'

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
  'x-whiteboard': { kind: 'shape' as const, shape: 'rectangle' as const },
}

function makeDeps(canvasDocStore: FakeCanvasDocStore) {
  return { canvasDocStore, workspaceIndex: {} as never, blobStore: {} as never }
}

describe('canvas_export_json_canvas tool', () => {
  test('strict mode drops the x-whiteboard extension key', async () => {
    const store = new FakeCanvasDocStore()
    await seedDoc(store, CANVAS_ID, (doc) => {
      writeSpatialCanvas(doc, { nodes: [NODE_WITH_EXTENSION], edges: [] })
    })
    const tool = createCanvasExportJsonCanvasTool(makeDeps(store))

    const result = await tool.execute({
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
    const tool = createCanvasExportJsonCanvasTool(makeDeps(store))

    const result = await tool.execute({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID })
    const parsed = JSON.parse(result.json)

    expect(parsed.nodes[0]['x-whiteboard']).toEqual({ kind: 'shape', shape: 'rectangle' })
  })

  test('rejects when the canvas has no stored snapshot', async () => {
    const tool = createCanvasExportJsonCanvasTool(makeDeps(new FakeCanvasDocStore()))

    await expect(tool.execute({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID })).rejects.toThrow(
      CanvasNotFoundError,
    )
  })
})
