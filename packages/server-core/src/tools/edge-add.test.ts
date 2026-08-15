import { writeDocumentKind, writeSpatialCanvas } from '@kamiazya/whiteboard-canvas-workspace'
import { describe, expect, test } from 'vitest'
import {
  FakeCanvasDocStore,
  registerCanvasInWorkspace,
  seedDoc,
} from '../test-utils/fake-canvas-doc-store.js'
import { unusedDocumentIndex } from '../test-utils/unused-document-index.js'
import { loadCanvasDoc } from './canvas-doc-io.js'
import { createEdgeAddTool, EdgeAlreadyExistsError } from './edge-add.js'
import { DocumentKindMismatchError, PatchValidationError } from './errors.js'

const CANVAS_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'

function makeDeps(canvasDocStore: FakeCanvasDocStore) {
  return { canvasDocStore, blobStore: {} as never, documentIndex: unusedDocumentIndex() }
}

function node(id: string) {
  return { id, type: 'text', x: 0, y: 0, width: 100, height: 50, text: id } as const
}

const EDGE = { id: 'e1', fromNode: 'a', toNode: 'b' } as const

async function seedTwoNodes(store: FakeCanvasDocStore, kind: 'spatial' | 'markdown' = 'spatial') {
  await registerCanvasInWorkspace(store, WORKSPACE_ID, CANVAS_ID)
  await seedDoc(store, CANVAS_ID, (doc) => {
    writeDocumentKind(doc, kind)
    writeSpatialCanvas(doc, { nodes: [node('a'), node('b')], edges: [] })
  })
}

describe('wb_edge_add', () => {
  test('connects two nodes', async () => {
    const store = new FakeCanvasDocStore()
    await seedTwoNodes(store)

    const result = await createEdgeAddTool(makeDeps(store)).execute({
      workspaceId: WORKSPACE_ID,
      canvasId: CANVAS_ID,
      edge: EDGE,
    })

    expect(result.edge.id).toBe('e1')
    const { canvas } = await loadCanvasDoc(makeDeps(store), CANVAS_ID)
    expect(canvas.edges).toHaveLength(1)
    expect(canvas.edges[0].fromNode).toBe('a')
  })

  test('keeps the edges already on the canvas', async () => {
    const store = new FakeCanvasDocStore()
    await registerCanvasInWorkspace(store, WORKSPACE_ID, CANVAS_ID)
    await seedDoc(store, CANVAS_ID, (doc) => {
      writeDocumentKind(doc, 'spatial')
      writeSpatialCanvas(doc, { nodes: [node('a'), node('b')], edges: [EDGE] })
    })

    await createEdgeAddTool(makeDeps(store)).execute({
      workspaceId: WORKSPACE_ID,
      canvasId: CANVAS_ID,
      edge: { id: 'e2', fromNode: 'b', toNode: 'a' },
    })

    const { canvas } = await loadCanvasDoc(makeDeps(store), CANVAS_ID)
    expect(canvas.edges.map((e) => e.id).sort()).toEqual(['e1', 'e2'])
  })

  test('refuses an id that is already taken rather than overwriting it', async () => {
    const store = new FakeCanvasDocStore()
    await registerCanvasInWorkspace(store, WORKSPACE_ID, CANVAS_ID)
    await seedDoc(store, CANVAS_ID, (doc) => {
      writeDocumentKind(doc, 'spatial')
      writeSpatialCanvas(doc, { nodes: [node('a'), node('b')], edges: [EDGE] })
    })

    await expect(
      createEdgeAddTool(makeDeps(store)).execute({
        workspaceId: WORKSPACE_ID,
        canvasId: CANVAS_ID,
        edge: { id: 'e1', fromNode: 'b', toNode: 'a' },
      }),
    ).rejects.toThrow(EdgeAlreadyExistsError)

    const { canvas } = await loadCanvasDoc(makeDeps(store), CANVAS_ID)
    expect(canvas.edges).toHaveLength(1)
    expect(canvas.edges[0].fromNode).toBe('a')
  })

  test('refuses an endpoint the canvas does not have', async () => {
    // spatialCanvasSchema owns the endpoint-existence invariant, so a
    // dangling edge is rejected by the same gate wb_edge_patch uses for a
    // retarget rather than by a check written twice.
    const store = new FakeCanvasDocStore()
    await seedTwoNodes(store)

    await expect(
      createEdgeAddTool(makeDeps(store)).execute({
        workspaceId: WORKSPACE_ID,
        canvasId: CANVAS_ID,
        edge: { id: 'e1', fromNode: 'a', toNode: 'ghost' },
      }),
    ).rejects.toThrow(PatchValidationError)

    const { canvas } = await loadCanvasDoc(makeDeps(store), CANVAS_ID)
    expect(canvas.edges).toHaveLength(0)
  })

  test('refuses a markdown document', async () => {
    const store = new FakeCanvasDocStore()
    await seedTwoNodes(store, 'markdown')

    await expect(
      createEdgeAddTool(makeDeps(store)).execute({
        workspaceId: WORKSPACE_ID,
        canvasId: CANVAS_ID,
        edge: EDGE,
      }),
    ).rejects.toThrow(DocumentKindMismatchError)
  })

  test('rejects when the canvas is not in the workspace', async () => {
    const store = new FakeCanvasDocStore()

    await expect(
      createEdgeAddTool(makeDeps(store)).execute({
        workspaceId: WORKSPACE_ID,
        canvasId: CANVAS_ID,
        edge: EDGE,
      }),
    ).rejects.toThrow()
  })
})
