import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, test } from 'vitest'
import { FakeDocumentStore } from '../test-utils/fake-document-store.js'
import { DOCUMENT_ID, makeDeps, seedCanvas, WORKSPACE_ID } from './_test-canvas-edit.js'
import { createCanvasEditTool } from './canvas-edit.js'

describe('wb_canvas_edit tidy scope', () => {
  test.each([
    [['zzz']],
    [['c', 'zzz']],
  ])('refuses a scope naming a node that is not on the canvas, rather than moving nothing (%j)', async (scope) => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, {
      nodes: [textNode({ id: 'c', x: 0, y: 0, width: 100, height: 100, text: 'C' })],
      edges: [],
    })
    const tool = createCanvasEditTool(makeDeps(store))

    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        mode: 'apply',
        ops: [{ op: 'tidy', scope }],
      }),
    ).rejects.toThrow(/node "zzz" is not on the canvas/)
  })
})
