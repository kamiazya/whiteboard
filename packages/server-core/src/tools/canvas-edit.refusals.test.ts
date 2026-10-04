import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, test } from 'vitest'
import { FakeDocumentStore } from '../test-utils/fake-document-store.js'
import { DOCUMENT_ID, makeDeps, seedCanvas, WORKSPACE_ID } from './_test-canvas-edit.js'
import { createCanvasEditTool } from './canvas-edit.js'

async function apply(ops: unknown[]) {
  const store = new FakeDocumentStore()
  await seedCanvas(store, {
    nodes: [
      textNode({ id: 'a', x: 0, y: 0, width: 100, height: 40, text: 'A' }),
      textNode({ id: 'b', x: 200, y: 0, width: 100, height: 40, text: 'B' }),
    ],
    edges: [{ id: 'e', from: { node: 'a' }, to: { node: 'b' } }],
  })
  return createCanvasEditTool(makeDeps(store)).execute({
    workspaceId: WORKSPACE_ID,
    documentId: DOCUMENT_ID,
    mode: 'apply',
    ops,
  } as never)
}

describe('wb_canvas_edit patch refusals read as refusals, not as crashes', () => {
  test('edge.remove of an id that is not on the canvas names the edge', async () => {
    await expect(apply([{ op: 'edge.remove', id: 'ghost' }])).rejects.toThrow(
      /edge "ghost" is not on the canvas/,
    )
  })

  test('a node.patch the schema rejects carries the schema reason, not a TypeError', async () => {
    const failure = await apply([{ op: 'node.patch', id: 'a', patch: { width: -10 } }]).then(
      () => null,
      (err: unknown) => err,
    )
    expect(failure).toBeInstanceOf(Error)
    expect(failure).not.toBeInstanceOf(TypeError)
  })
})
