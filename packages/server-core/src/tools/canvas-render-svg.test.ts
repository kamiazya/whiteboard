import { writeSpatialCanvas } from '@kamiazya/whiteboard-canvas-workspace'
import { describe, expect, test } from 'vitest'
import { CanvasNotFoundError } from '../render/load-spatial-canvas.js'
import { FakeCanvasDocStore, seedDoc } from '../test-utils/fake-canvas-doc-store.js'
import { createCanvasRenderSvgTool } from './canvas-render-svg.js'

const CANVAS_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'

function makeDeps(canvasDocStore: FakeCanvasDocStore) {
  return { canvasDocStore, blobStore: {} as never, documentIndex: canvasDocStore.documentIndex }
}

describe('wb_scene_render tool', () => {
  test('renders a seeded canvas to SVG with dimensions', async () => {
    const store = new FakeCanvasDocStore()
    await seedDoc(store, CANVAS_ID, (doc) => {
      writeSpatialCanvas(doc, {
        nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'hi' }],
        edges: [],
      })
    })
    const tool = createCanvasRenderSvgTool(makeDeps(store))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      canvasId: CANVAS_ID,
      embedReferences: false,
    })

    expect(result.svg).toContain('<svg xmlns="http://www.w3.org/2000/svg">')
    expect(result.svg).toContain('hi')
    // The node's chrome — absent from every MCP-rendered SVG before this
    // migration, since the old builder degraded every node to an empty
    // `<g>` with no visible shape.
    expect(result.svg).toContain('<rect')
    expect(result.width).toBe(100)
    expect(result.height).toBe(50)
  })

  test('rejects when the canvas has no stored snapshot', async () => {
    const tool = createCanvasRenderSvgTool(makeDeps(new FakeCanvasDocStore()))

    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        canvasId: CANVAS_ID,
        embedReferences: false,
      }),
    ).rejects.toThrow(CanvasNotFoundError)
  })
})
