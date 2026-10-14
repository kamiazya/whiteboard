import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, test } from 'vitest'
import { FakeDocumentStore } from '../test-utils/fake-document-store.js'
import { DOCUMENT_ID, EMPTY, makeDeps, seedCanvas, WORKSPACE_ID } from './_test-canvas-edit.js'
import { createCanvasEditTool } from './canvas-edit.js'

async function run(canvas: Parameters<typeof seedCanvas>[1], op: unknown) {
  const store = new FakeDocumentStore()
  await seedCanvas(store, canvas)
  return createCanvasEditTool(makeDeps(store)).execute({
    workspaceId: WORKSPACE_ID,
    documentId: DOCUMENT_ID,
    mode: 'apply',
    ops: [op],
  } as never)
}

// A selector that matches nothing is refused rather than answered as a
// no-op success, so a caller that named the wrong scope hears about it.
describe('wb_canvas_edit refuses a selector that matches nothing', () => {
  test('edge.remove within a group holding no edge', async () => {
    const canvas = {
      nodes: [
        groupNode({ id: 'g', x: 0, y: 0, width: 600, height: 400 }),
        textNode({ id: 'a', x: 40, y: 40, width: 100, height: 60, text: 'a' }),
        textNode({ id: 'b', x: 900, y: 40, width: 100, height: 60, text: 'b' }),
      ],
      edges: [{ id: 'e', from: { node: 'a' }, to: { node: 'b' } }],
    }

    await expect(run(canvas, { op: 'edge.remove', within: 'g' })).rejects.toMatchObject({
      name: 'CanvasEditError',
      opIndex: 0,
      message: expect.stringMatching(/no edge has both ends inside "g"/),
    })
  })

  test('node.lock with `all` on a canvas with no nodes', async () => {
    await expect(run(EMPTY, { op: 'node.lock', all: true, locked: true })).rejects.toMatchObject({
      name: 'CanvasEditError',
      opIndex: 0,
      message: expect.stringMatching(/the canvas has no nodes/),
    })
  })
})
