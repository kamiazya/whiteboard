import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, test } from 'vitest'
import { loadDocument } from '../document-io.js'
import { FakeDocumentStore } from '../test-utils/fake-document-store.js'
import { DOCUMENT_ID, makeDeps, seedCanvas, WORKSPACE_ID } from './_test-canvas-edit.js'
import { createCanvasEditTool } from './canvas-edit.js'

const GROUP = groupNode({ id: 'g', x: 0, y: 0, width: 500, height: 500, label: 'Phase 1' })

async function run(
  canvas: Parameters<typeof seedCanvas>[1],
  ops: unknown[],
  mode: 'apply' | 'propose' = 'apply',
) {
  const store = new FakeDocumentStore()
  await seedCanvas(store, canvas)
  const deps = makeDeps(store)
  const tool = createCanvasEditTool(deps)
  const result = tool.execute({
    workspaceId: WORKSPACE_ID,
    documentId: DOCUMENT_ID,
    mode,
    ops,
  } as never)
  return { result, deps }
}

describe('wb_canvas_edit refuses a node.add whose id is taken', () => {
  test('against a node already on the canvas, naming the id, and stores nothing', async () => {
    const { result, deps } = await run(
      {
        nodes: [textNode({ id: 'a', x: 0, y: 0, width: 100, height: 40, text: 'first' })],
        edges: [],
      },
      [
        {
          op: 'node.add',
          node: { type: 'text', id: 'a', x: 300, y: 0, width: 100, height: 40, text: 'second' },
        },
      ],
    )
    await expect(result).rejects.toThrow(/node id "a" is already on the canvas/)
    const { canvas } = await loadDocument(deps, WORKSPACE_ID, DOCUMENT_ID)
    expect(canvas.nodes.map((n) => n.id)).toEqual(['a'])
  })

  test('against a node added earlier in the same batch', async () => {
    const { result } = await run({ nodes: [], edges: [] }, [
      {
        op: 'node.add',
        node: { type: 'text', id: 'a', x: 0, y: 0, width: 100, height: 40, text: 'one' },
      },
      {
        op: 'node.add',
        node: { type: 'text', id: 'a', x: 300, y: 0, width: 100, height: 40, text: 'two' },
      },
    ])
    await expect(result).rejects.toThrow(/node id "a" is already on the canvas/)
  })
})

describe('a within selector reaches every node a group holds, flush with its edges included', () => {
  const flush = [
    textNode({ id: 'top-left', x: 0, y: 0, width: 100, height: 100, text: 'tl' }),
    textNode({ id: 'bottom-right', x: 400, y: 400, width: 100, height: 100, text: 'br' }),
    textNode({ id: 'outside', x: 501, y: 0, width: 100, height: 100, text: 'out' }),
  ]

  test('node.patch within', async () => {
    const { result } = await run({ nodes: [GROUP, ...flush], edges: [] }, [
      { op: 'node.patch', within: 'g', patch: { color: '2' } },
    ])
    expect([...(await result).touched.nodes].sort()).toEqual(['bottom-right', 'top-left'])
  })

  test('a node one pixel past the right edge is not inside', async () => {
    const { result } = await run(
      {
        nodes: [GROUP, textNode({ id: 'tight', x: 401, y: 0, width: 100, height: 100, text: 't' })],
        edges: [],
      },
      [{ op: 'node.patch', within: 'g', patch: { color: '2' } }],
    )
    await expect(result).rejects.toThrow(/no node is inside "g"/)
  })
})

describe('node.add within grows the group only when the new box passes its edge', () => {
  test('a box that exactly fills the group leaves its size alone; one pixel more grows it', async () => {
    const fits = await run({ nodes: [GROUP], edges: [] }, [
      {
        op: 'node.add',
        within: 'g',
        node: { type: 'text', id: 'fit', x: 400, y: 400, width: 100, height: 100, text: 'f' },
      },
    ])
    const fitted = (await fits.result).snapshot.nodes.find((n) => n.id === 'g')
    expect([fitted?.width, fitted?.height]).toEqual([500, 500])

    const over = await run({ nodes: [GROUP], edges: [] }, [
      {
        op: 'node.add',
        within: 'g',
        node: { type: 'text', id: 'over', x: 400, y: 400, width: 101, height: 101, text: 'o' },
      },
    ])
    const grown = (await over.result).snapshot.nodes.find((n) => n.id === 'g')
    expect(grown?.width).toBeGreaterThan(500)
    expect(grown?.height).toBeGreaterThan(500)
  })
})
