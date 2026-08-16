// `canvas_view` is the MCP Apps (SEP-1865) UI tool: its result is what the
// host hands the inline canvas widget, so unlike every other tool here its
// payload is consumed by a RENDERER rather than by a model.
//
// It carries resolved references alongside the scene because the widget has
// no store of its own — it receives a snapshot and lays it out itself, so a
// file node's referenced markdown can only reach it if the server puts it in
// the payload.
import { writeDocumentKind, writeSpatialCanvas } from '@kamiazya/whiteboard-canvas-workspace'
import { describe, expect, test } from 'vitest'
import { FakeCanvasDocStore, seedDoc } from '../test-utils/fake-canvas-doc-store.js'
import { canvasViewOutputSchema, createCanvasViewTool } from './canvas-view.js'

const CANVAS_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const NOTE_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V8'
const WORKSPACE_ID = 'ws-1'

function makeDeps(canvasDocStore: FakeCanvasDocStore) {
  return { canvasDocStore, blobStore: {} as never, documentIndex: canvasDocStore.documentIndex }
}

async function seedWorkspace(store: FakeCanvasDocStore) {
  store.documentIndex.seed({
    workspaceId: WORKSPACE_ID,
    path: 'board',
    canvasId: CANVAS_ID,
    kind: 'spatial',
  })
  store.documentIndex.seed({
    workspaceId: WORKSPACE_ID,
    path: 'notes',
    canvasId: NOTE_ID,
    kind: 'markdown',
    name: 'Weekly',
  })
  await seedDoc(store, CANVAS_ID, (doc) => {
    writeDocumentKind(doc, 'spatial')
    writeSpatialCanvas(doc, {
      nodes: [
        { id: 't1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'hello' },
        { id: 'f1', type: 'file', x: 200, y: 0, width: 320, height: 220, file: NOTE_ID },
      ],
      edges: [],
    })
  })
  await seedDoc(store, NOTE_ID, (doc) => {
    writeDocumentKind(doc, 'markdown')
    writeSpatialCanvas(doc, {
      nodes: [
        {
          id: 'okf-body',
          type: 'text',
          x: 0,
          y: 0,
          width: 600,
          height: 400,
          text: '# Weekly notes\n\nShipped it.',
        },
      ],
      edges: [],
    })
  })
}

describe('canvas_view tool', () => {
  test('returns the scene the widget lays out, plus the id it refreshes with', async () => {
    const store = new FakeCanvasDocStore()
    await seedWorkspace(store)
    const tool = createCanvasViewTool(makeDeps(store))

    const result = await tool.execute({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID })

    expect(result.canvasId).toBe(CANVAS_ID)
    // Sorted: node order is whatever `readSpatialCanvas` gives back, not the
    // order they were written in. What this pins is that the whole document
    // reaches the widget, not a projection of it.
    expect(result.scene.nodes.map((node) => node.id).sort()).toEqual(['f1', 't1'])
  })

  test('carries the referenced markdown document body, parsed', async () => {
    const store = new FakeCanvasDocStore()
    await seedWorkspace(store)
    const tool = createCanvasViewTool(makeDeps(store))

    const result = await tool.execute({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID })

    const reference = result.references[NOTE_ID]
    expect(reference?.label).toBe('Weekly')
    expect(reference?.body?.children[0]).toMatchObject({ type: 'heading', depth: 1 })
  })

  test('validates against its own outputSchema, which the widget parses', () => {
    // The payload crosses two process boundaries (server -> host -> widget),
    // so `references` is schematized rather than passed as unknown — a
    // hand-written type on the widget side is the drift this prevents.
    const parsed = canvasViewOutputSchema.safeParse({
      canvasId: CANVAS_ID,
      scene: { nodes: [], edges: [] },
      references: { [NOTE_ID]: { label: 'Weekly', body: { type: 'root', children: [] } } },
    })
    expect(parsed.success).toBe(true)
  })

  test('rejects a reference body that is not a real mdast root', () => {
    const parsed = canvasViewOutputSchema.safeParse({
      canvasId: CANVAS_ID,
      scene: { nodes: [], edges: [] },
      references: { x: { body: { type: 'nonsense' } } },
    })
    expect(parsed.success).toBe(false)
  })

  test('returns an empty reference map for a canvas with no file nodes', async () => {
    const store = new FakeCanvasDocStore()
    store.documentIndex.seed({
      workspaceId: WORKSPACE_ID,
      path: 'board',
      canvasId: CANVAS_ID,
      kind: 'spatial',
    })
    await seedDoc(store, CANVAS_ID, (doc) => {
      writeDocumentKind(doc, 'spatial')
      writeSpatialCanvas(doc, {
        nodes: [{ id: 't1', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'hi' }],
        edges: [],
      })
    })
    const tool = createCanvasViewTool(makeDeps(store))

    const result = await tool.execute({ workspaceId: WORKSPACE_ID, canvasId: CANVAS_ID })

    expect(result.references).toEqual({})
  })
})
