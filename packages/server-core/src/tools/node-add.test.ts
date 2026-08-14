import {
  readDocumentKind,
  writeDocumentKind,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-canvas-workspace'
import { describe, expect, test } from 'vitest'
import {
  FakeCanvasDocStore,
  registerCanvasInWorkspace,
  seedDoc,
} from '../test-utils/fake-canvas-doc-store.js'
import { loadCanvasDoc } from './canvas-doc-io.js'
import { DocumentKindMismatchError } from './errors.js'
import { createNodeAddTool, NodeAlreadyExistsError } from './node-add.js'

const CANVAS_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'

function makeDeps(canvasDocStore: FakeCanvasDocStore) {
  return { canvasDocStore, blobStore: {} as never }
}

const RECT = {
  id: 'n1',
  type: 'text',
  x: 10,
  y: 20,
  width: 200,
  height: 100,
  text: 'hello',
} as const

describe('wb_node_add', () => {
  test('adds a node to an empty spatial canvas', async () => {
    const store = new FakeCanvasDocStore()
    await registerCanvasInWorkspace(store, WORKSPACE_ID, CANVAS_ID)
    await seedDoc(store, CANVAS_ID, (doc) => {
      writeSpatialCanvas(doc, { nodes: [], edges: [] })
    })
    const tool = createNodeAddTool(makeDeps(store))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      canvasId: CANVAS_ID,
      node: RECT,
    })

    expect(result.node.id).toBe('n1')
    const canvas = (await loadCanvasDoc(makeDeps(store), CANVAS_ID)).canvas
    expect(canvas.nodes).toHaveLength(1)
  })

  test('keeps the nodes already on the canvas', async () => {
    // The gap this closes is that the only previous way to get a node in was
    // wb_document_set, which replaced the whole canvas. Adding must add.
    const store = new FakeCanvasDocStore()
    await registerCanvasInWorkspace(store, WORKSPACE_ID, CANVAS_ID)
    await seedDoc(store, CANVAS_ID, (doc) => {
      writeSpatialCanvas(doc, { nodes: [RECT], edges: [] })
    })
    const tool = createNodeAddTool(makeDeps(store))

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      canvasId: CANVAS_ID,
      node: { ...RECT, id: 'n2', text: 'second' },
    })

    const canvas = (await loadCanvasDoc(makeDeps(store), CANVAS_ID)).canvas
    expect(canvas.nodes.map((n) => n.id).sort()).toEqual(['n1', 'n2'])
  })

  test('refuses an id that is already taken rather than overwriting it', async () => {
    const store = new FakeCanvasDocStore()
    await registerCanvasInWorkspace(store, WORKSPACE_ID, CANVAS_ID)
    await seedDoc(store, CANVAS_ID, (doc) => {
      writeSpatialCanvas(doc, { nodes: [RECT], edges: [] })
    })
    const tool = createNodeAddTool(makeDeps(store))

    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        canvasId: CANVAS_ID,
        node: { ...RECT, text: 'clobber' },
      }),
    ).rejects.toThrow(NodeAlreadyExistsError)

    const canvas = (await loadCanvasDoc(makeDeps(store), CANVAS_ID)).canvas
    expect(canvas.nodes).toHaveLength(1)
    if (canvas.nodes[0].type === 'text') expect(canvas.nodes[0].text).toBe('hello')
  })

  test('refuses a markdown document, whose only node holds its OKF body', async () => {
    // A markdown document stores its body as a text node, so a second node
    // added beside it is content no OKF projection can represent — nodes are
    // JSON Canvas (ADR-0009 decision 3).
    const store = new FakeCanvasDocStore()
    await registerCanvasInWorkspace(store, WORKSPACE_ID, CANVAS_ID)
    await seedDoc(store, CANVAS_ID, (doc) => {
      writeDocumentKind(doc, 'markdown')
      writeSpatialCanvas(doc, { nodes: [], edges: [] })
    })
    const tool = createNodeAddTool(makeDeps(store))

    await expect(
      tool.execute({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, node: RECT }),
    ).rejects.toThrow(DocumentKindMismatchError)

    expect((await loadCanvasDoc(makeDeps(store), CANVAS_ID)).canvas.nodes).toHaveLength(0)
  })

  test('a document predating kinds is recorded as spatial by the write', async () => {
    const store = new FakeCanvasDocStore()
    await registerCanvasInWorkspace(store, WORKSPACE_ID, CANVAS_ID)
    await seedDoc(store, CANVAS_ID, (doc) => {
      writeSpatialCanvas(doc, { nodes: [], edges: [] })
    })
    const tool = createNodeAddTool(makeDeps(store))

    await tool.execute({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, node: RECT })

    expect(readDocumentKind((await loadCanvasDoc(makeDeps(store), CANVAS_ID)).doc)).toBe('spatial')
  })

  test('rejects when the canvas is not in the workspace', async () => {
    const store = new FakeCanvasDocStore()
    const tool = createNodeAddTool(makeDeps(store))

    await expect(
      tool.execute({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID, node: RECT }),
    ).rejects.toThrow()
  })
})
