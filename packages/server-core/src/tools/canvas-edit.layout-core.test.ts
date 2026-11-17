import {
  constantRatioMeasureText,
  type LayoutCore,
  type QueryRequest,
  tidyBoxes,
  tidyNodes,
} from '@kamiazya/whiteboard-canvas-render'
import { fakeLayoutCore } from '@kamiazya/whiteboard-canvas-render/test-utils'
import { testLayoutCore } from '@kamiazya/whiteboard-canvas-render/test-utils/node-core'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { loadDocument } from '../document-io.js'
import { FakeDocumentStore } from '../test-utils/fake-document-store.js'
import { DOCUMENT_ID, EMPTY, makeDeps, seedCanvas, WORKSPACE_ID } from './_test-canvas-edit.js'
import { createCanvasEditTool } from './canvas-edit.js'

/**
 * `wb_canvas_edit` sizes a text node through the daemon's layout core where
 * its layout switch says so (ADR-0054 step 7, S18d): the height a new box
 * gets is the core's `node-size` answer, and a batch that sizes nothing does
 * not ask for the core at all.
 */
describe('wb_canvas_edit sizing through the layout core', () => {
  function withCore() {
    const asked: QueryRequest[] = []
    let loads = 0
    const core: LayoutCore = fakeLayoutCore({
      query: {
        layoutQuery: (request) => {
          asked.push(request)
          return { numbers: [[123]] }
        },
      },
    })
    const store = new FakeDocumentStore()
    const deps = {
      ...makeDeps(store),
      textMeasurer: async () => ({
        measure: constantRatioMeasureText,
        measurableFamilies: new Set<string>(),
      }),
      layoutCore: async () => {
        loads += 1
        return core
      },
    }
    return { store, deps, asked, loads: () => loads }
  }

  it('gives a new text node the height the core answers', async () => {
    const { store, deps, asked } = withCore()
    await seedCanvas(store, EMPTY)
    await createCanvasEditTool(deps).execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [{ op: 'node.add', node: { id: 'n', type: 'text', text: 'hello' } }],
    })
    const { canvas } = await loadDocument(deps, WORKSPACE_ID, DOCUMENT_ID)
    expect(canvas.nodes[0]?.height).toBe(123)
    expect(asked).toEqual([
      expect.objectContaining({
        query: 'node-size',
        measure: { kind: 'ratio' },
        mode: 'light',
        floor: 'ratio',
      }),
    ])
  })

  it('refuses a named height short of what the core answers, naming that height', async () => {
    const { store, deps } = withCore()
    await seedCanvas(store, EMPTY)
    const add = createCanvasEditTool(deps).execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [{ op: 'node.add', node: { id: 'n', type: 'text', text: 'hello', height: 40 } }],
    })
    await expect(add).rejects.toThrow(/needs 123px of height/)
  })

  it('refuses a patch whose text the core says the box cannot hold', async () => {
    const { store, deps } = withCore()
    await seedCanvas(store, {
      nodes: [textNode({ id: 'n', x: 0, y: 0, width: 200, height: 40, text: 'a' })],
      edges: [],
    })
    const patch = createCanvasEditTool(deps).execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [{ op: 'node.patch', id: 'n', patch: { text: 'hello' } }],
    })
    await expect(patch).rejects.toThrow(/needs 123px of height/)
  })

  it('does not ask for the core when no op sizes a node', async () => {
    const { store, deps, loads } = withCore()
    await seedCanvas(store, EMPTY)
    await createCanvasEditTool(deps).execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [{ op: 'node.add', node: { id: 'g', type: 'group', label: 'frame' } }],
    })
    expect(loads()).toBe(0)
  })
})

describe('wb_canvas_edit tidy through the layout core', () => {
  const board = {
    nodes: [
      textNode({ id: 'a', x: 0, y: 0, width: 100, height: 40, text: 'a' }),
      textNode({ id: 'b', x: 200, y: 3, width: 100, height: 40, text: 'b' }),
    ],
    edges: [],
  }
  const tidyOp = [{ op: 'tidy' }] as const

  it('applies the moves the core answers and asks it once, with no measurer needed', async () => {
    const asked: QueryRequest[] = []
    const core = fakeLayoutCore({
      query: {
        layoutQuery: (request) => {
          asked.push(request)
          return { moves: [['b', 200, 0]] }
        },
      },
    })
    const store = new FakeDocumentStore()
    const deps = { ...makeDeps(store), layoutCore: async () => core }
    await seedCanvas(store, board)
    await createCanvasEditTool(deps).execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [...tidyOp],
    })
    const { canvas } = await loadDocument(deps, WORKSPACE_ID, DOCUMENT_ID)
    expect(canvas.nodes.map((n) => [n.id, n.x, n.y])).toEqual([
      ['a', 0, 0],
      ['b', 200, 0],
    ])
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ query: 'tidy', locked: [] })
  })

  it('lands the moves the real core answers on the stored canvas', async () => {
    const store = new FakeDocumentStore()
    const deps = { ...makeDeps(store), layoutCore: async () => testLayoutCore() }
    await seedCanvas(store, board)
    await createCanvasEditTool(deps).execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [...tidyOp],
    })
    const { canvas } = await loadDocument(deps, WORKSPACE_ID, DOCUMENT_ID)
    const direct = tidyNodes(tidyBoxes(board.nodes), { core: testLayoutCore() })
    expect(direct).toEqual([{ id: 'b', x: 200, y: 0 }])
    expect(canvas.nodes.find((n) => n.id === 'b')?.y).toBe(0)
  })

  it('never moves a locked node, whatever the core answers for it', async () => {
    const core = fakeLayoutCore({
      query: { layoutQuery: () => ({ moves: [['b', 201, 1]] }) },
    })
    const store = new FakeDocumentStore()
    const deps = { ...makeDeps(store), layoutCore: async () => core }
    await seedCanvas(store, board)
    await createCanvasEditTool(deps).execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [{ op: 'node.lock', id: 'b', locked: true }, ...tidyOp],
    })
    const { canvas } = await loadDocument(deps, WORKSPACE_ID, DOCUMENT_ID)
    expect(canvas.nodes.find((n) => n.id === 'b')).toMatchObject({ x: 200, y: 3 })
  })
})
