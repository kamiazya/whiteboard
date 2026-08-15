import { writeFacets, writeSpatialCanvas } from '@kamiazya/whiteboard-canvas-workspace'
import { describe, expect, test } from 'vitest'
import { CanvasNotFoundError } from '../render/load-spatial-canvas.js'
import { FakeCanvasDocStore, seedDoc } from '../test-utils/fake-canvas-doc-store.js'
import { exportOkf } from './export-okf.js'

const CANVAS_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'

function makeDeps(canvasDocStore: FakeCanvasDocStore) {
  return { canvasDocStore, blobStore: {} as never, documentIndex: canvasDocStore.documentIndex }
}

describe('exportOkf', () => {
  test('exports the first text node body with facets from the doc', async () => {
    const store = new FakeCanvasDocStore()
    await seedDoc(store, CANVAS_ID, (doc) => {
      writeSpatialCanvas(doc, {
        nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'hello' }],
        edges: [],
      })
      writeFacets(doc, { 'kanban/1': { status: 'todo' } })
    })
    const result = await exportOkf(makeDeps(store), {
      workspaceId: WORKSPACE_ID,
      canvasId: CANVAS_ID,
    })

    expect(result.markdown.startsWith('---\n')).toBe(true)
    expect(result.markdown).toContain('hello')
    expect(result.frontmatter.facets).toEqual({ 'kanban/1': { status: 'todo' } })
  })

  test('falls back to an empty body when the canvas has no text node', async () => {
    const store = new FakeCanvasDocStore()
    await seedDoc(store, CANVAS_ID, (doc) => {
      writeSpatialCanvas(doc, {
        nodes: [{ id: 'n1', type: 'group', x: 0, y: 0, width: 100, height: 50 }],
        edges: [],
      })
    })
    const result = await exportOkf(makeDeps(store), {
      workspaceId: WORKSPACE_ID,
      canvasId: CANVAS_ID,
    })

    expect(result.markdown.endsWith('---\n')).toBe(true)
  })

  test('rejects when the canvas has no stored snapshot', async () => {
    await expect(
      exportOkf(makeDeps(new FakeCanvasDocStore()), {
        workspaceId: WORKSPACE_ID,
        canvasId: CANVAS_ID,
      }),
    ).rejects.toThrow(CanvasNotFoundError)
  })
})
