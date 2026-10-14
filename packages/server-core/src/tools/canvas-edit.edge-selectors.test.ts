/**
 * `all` on an edge op: the edge twin of `node.lock {all}` in
 * `canvas-edit.test.ts`. "Remove every edge" and "lock every edge" are
 * one-call errands for resetting or freezing a diagram, so a partial answer
 * — one edge of several — leaves a canvas that reads as done and is not,
 * and a refusal on a canvas that HAS edges makes the errand impossible.
 */
import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, test } from 'vitest'
import { loadDocument } from '../document-io.js'
import { FakeDocumentStore } from '../test-utils/fake-document-store.js'
import { DOCUMENT_ID, makeDeps, seedCanvas, WORKSPACE_ID } from './_test-canvas-edit.js'
import { createCanvasEditTool } from './canvas-edit.js'

// Three edges, one of them with an end outside the group, so `all` cannot
// be confused with `within` and a first-edge-only answer is visible.
const NODES = [
  groupNode({ id: 'g', x: 0, y: 0, width: 500, height: 500 }),
  textNode({ id: 'a', x: 20, y: 20, width: 80, height: 40, text: 'a' }),
  textNode({ id: 'b', x: 200, y: 20, width: 80, height: 40, text: 'b' }),
  textNode({ id: 'far', x: 900, y: 900, width: 80, height: 40, text: 'far' }),
]
const BOARD = {
  nodes: NODES,
  edges: [
    { id: 'ab', from: { node: 'a' }, to: { node: 'b' } },
    { id: 'ba', from: { node: 'b' }, to: { node: 'a' } },
    { id: 'bfar', from: { node: 'b' }, to: { node: 'far' } },
  ],
}

describe('wb_canvas_edit — `all` on an edge op', () => {
  test('edge.lock with `all` locks every edge on the canvas', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, BOARD)
    const tool = createCanvasEditTool(makeDeps(store))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [{ op: 'edge.lock', all: true, locked: true }],
    })

    expect(result.snapshot.edges.map((edge) => [edge.id, edge.locked])).toEqual([
      ['ab', true],
      ['ba', true],
      ['bfar', true],
    ])
    expect(result.snapshot.nodes.some((node) => node.locked === true)).toBe(false)
    expect([...result.touched.edges].sort()).toEqual(['ab', 'ba', 'bfar'])
  })

  test('edge.remove with `all` removes every edge and keeps every node', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, BOARD)
    const tool = createCanvasEditTool(makeDeps(store))

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [{ op: 'edge.remove', all: true }],
    })

    const { canvas } = await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)
    expect(canvas.edges).toEqual([])
    expect(canvas.nodes.map((node) => node.id).sort()).toEqual(['a', 'b', 'far', 'g'])
  })

  test('edge.remove with `all` on a canvas with no edges is refused', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, { nodes: NODES, edges: [] })
    const tool = createCanvasEditTool(makeDeps(store))

    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        mode: 'apply',
        ops: [{ op: 'edge.remove', all: true }],
      }),
    ).rejects.toMatchObject({
      name: 'CanvasEditError',
      opIndex: 0,
      message: expect.stringMatching(/the canvas has no edges/),
    })
  })
})
