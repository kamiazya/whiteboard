import { sceneDigest, sceneDigestSchema } from '@kamiazya/whiteboard-canvas-render'
import { writeSpatialCanvas } from '@kamiazya/whiteboard-canvas-workspace'
import { describe, expect, test } from 'vitest'
import { composeCanvasScene } from '../render/compose-canvas-scene.js'
import { fallbackMeasureText } from '../render/fallback-measure.js'
import { CanvasNotFoundError } from '../render/load-spatial-canvas.js'
import { FakeCanvasDocStore, seedDoc } from '../test-utils/fake-canvas-doc-store.js'
import { createCanvasDigestTool } from './canvas-digest.js'

const CANVAS_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'

function makeDeps(canvasDocStore: FakeCanvasDocStore) {
  return { canvasDocStore, blobStore: {} as never }
}

describe('canvas_digest tool', () => {
  test('matches sceneDigest computed directly over an overlapping two-node canvas', async () => {
    const store = new FakeCanvasDocStore()
    const canvas = {
      nodes: [
        { id: 'n1', type: 'group' as const, x: 0, y: 0, width: 100, height: 100 },
        { id: 'n2', type: 'group' as const, x: 50, y: 50, width: 100, height: 100 },
      ],
      edges: [],
    }
    await seedDoc(store, CANVAS_ID, (doc) => {
      writeSpatialCanvas(doc, canvas)
    })
    const tool = createCanvasDigestTool(makeDeps(store))

    const result = await tool.execute({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID })
    const expected = sceneDigest(composeCanvasScene(canvas, fallbackMeasureText))

    expect(result).toEqual(expected)
    expect(result.overlaps.length).toBeGreaterThan(0)
    expect(() => sceneDigestSchema.parse(result)).not.toThrow()
  })

  test('rejects when the canvas has no stored snapshot', async () => {
    const tool = createCanvasDigestTool(makeDeps(new FakeCanvasDocStore()))

    await expect(tool.execute({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID })).rejects.toThrow(
      CanvasNotFoundError,
    )
  })
})
