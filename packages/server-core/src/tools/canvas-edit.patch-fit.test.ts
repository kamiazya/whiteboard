import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, test } from 'vitest'
import { loadDocument } from '../document-io.js'
import { FakeDocumentStore } from '../test-utils/fake-document-store.js'
import { DOCUMENT_ID, makeDeps, seedCanvas, WORKSPACE_ID } from './_test-canvas-edit.js'
import { createCanvasEditTool } from './canvas-edit.js'

// Measures 96px tall in a 260-wide box, so it fits the 120px seed below and
// only a narrower width pushes it past the box.
const JA =
  'これは日本語の長い文章です。ノードの幅を超えても折り返されるべきですが、' +
  '既定の高さのままだと入りきりません。だから作るときに測ります。'

describe('wb_canvas_edit node.patch and the width a text needs', () => {
  // Matching a box to its column is the commonest width patch, and the one
  // that cuts a sentence where nothing the caller can see says so.
  test('a width patch that narrows the box below its text is refused and stores nothing', async () => {
    const store = new FakeDocumentStore()
    const seeded = textNode({ id: 'n', x: 0, y: 0, width: 260, height: 120, text: JA })
    await seedCanvas(store, { nodes: [seeded], edges: [] })
    const tool = createCanvasEditTool(makeDeps(store))

    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        mode: 'apply',
        ops: [{ op: 'node.patch', id: 'n', patch: { width: 80 } }],
      }),
    ).rejects.toThrow(/needs \d+px of height at width 80/)

    const { canvas } = await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)
    expect(canvas.nodes[0]).toMatchObject({ width: 260, height: 120 })
  })
})
