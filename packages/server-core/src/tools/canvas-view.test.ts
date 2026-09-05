// `canvas_view` is the MCP Apps (SEP-1865) UI tool: its result is what the
// host hands the inline canvas widget, so unlike every other tool here its
// payload is consumed by a RENDERER rather than by a model.
//
// It carries resolved references alongside the scene because the widget has
// no store of its own — it receives a snapshot and lays it out itself, so a
// file node's referenced markdown can only reach it if the server puts it in
// the payload.

import {
  writeDocumentKind,
  writeMarkdownBody,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { describe, expect, test } from 'vitest'
import type { ServerDeps } from '../server-deps.js'
import { FakeDocumentStore, seedDoc } from '../test-utils/fake-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { canvasViewOutputSchema, createCanvasViewTool } from './canvas-view.js'

const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const NOTE_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V8'
const WORKSPACE_ID = 'ws-1'

function makeDeps(documentStore: FakeDocumentStore): ServerDeps {
  return makeTestDeps({
    documentStore: documentStore,
    documentIndex: documentStore.documentIndex,
  })
}

async function seedWorkspace(store: FakeDocumentStore) {
  store.documentIndex.seed({
    workspaceId: WORKSPACE_ID,
    path: 'board',
    documentId: DOCUMENT_ID,
    kind: 'spatial',
  })
  store.documentIndex.seed({
    workspaceId: WORKSPACE_ID,
    path: 'notes',
    documentId: NOTE_ID,
    kind: 'markdown',
    name: 'Weekly',
  })
  await seedDoc(store, DOCUMENT_ID, (doc) => {
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
    const store = new FakeDocumentStore()
    await seedWorkspace(store)
    const tool = createCanvasViewTool(makeDeps(store))

    const result = await tool.execute({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID })

    expect(result.documentId).toBe(DOCUMENT_ID)
    // BOTH ids echo, because the widget's follow-up calls (Refresh, the
    // sticky-note append) re-invoke tools whose strict input schemas require
    // the workspaceId too — an echo of documentId alone leaves the widget
    // unable to construct a valid call.
    expect(result.workspaceId).toBe(WORKSPACE_ID)
    expect(canvasViewOutputSchema.parse(result).workspaceId).toBe(WORKSPACE_ID)
    // Sorted: node order is whatever `readSpatialCanvas` gives back, not the
    // order they were written in. What this pins is that the whole document
    // reaches the widget, not a projection of it.
    expect(result.scene.nodes.map((node) => node.id).sort()).toEqual(['f1', 't1'])
  })

  test('carries the referenced markdown document as its name and raw body', async () => {
    const store = new FakeDocumentStore()
    await seedWorkspace(store)
    const tool = createCanvasViewTool(makeDeps(store))

    const result = await tool.execute({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID })

    const reference = result.references[NOTE_ID]
    expect(reference?.name).toBe('Weekly')
    expect(reference?.body).toContain('# Weekly notes')
    expect(reference?.canvas).toBeUndefined()
  })

  test('carries a referenced spatial document as its canvas, so the widget draws a miniature', async () => {
    const store = new FakeDocumentStore()
    await seedWorkspace(store)
    const BOARD_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8VB'
    store.documentIndex.seed({
      workspaceId: WORKSPACE_ID,
      path: 'board-2',
      documentId: BOARD_ID,
      kind: 'spatial',
      name: 'Board two',
    })
    await seedDoc(store, BOARD_ID, (doc) => {
      writeDocumentKind(doc, 'spatial')
      writeSpatialCanvas(doc, {
        nodes: [{ id: 'x', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'INNER' }],
        edges: [],
      })
    })
    await seedDoc(store, DOCUMENT_ID, (doc) => {
      writeDocumentKind(doc, 'spatial')
      writeSpatialCanvas(doc, {
        nodes: [{ id: 'f2', type: 'file', x: 0, y: 0, width: 300, height: 200, file: BOARD_ID }],
        edges: [],
      })
    })
    const tool = createCanvasViewTool(makeDeps(store))

    const result = await tool.execute({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID })

    expect(result.references[BOARD_ID]?.name).toBe('Board two')
    expect(result.references[BOARD_ID]?.canvas?.nodes[0]).toMatchObject({ id: 'x' })
    expect(result.references[BOARD_ID]?.body).toBeUndefined()
  })

  test('validates against its own outputSchema, which the widget parses', () => {
    // The payload crosses two process boundaries (server -> host -> widget),
    // so `references` is schematized rather than passed as unknown — a
    // hand-written type on the widget side is the drift this prevents.
    const parsed = canvasViewOutputSchema.safeParse({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      scene: { nodes: [], edges: [] },
      references: { [NOTE_ID]: { name: 'Weekly', body: '# Weekly' } },
    })
    expect(parsed.success).toBe(true)
  })

  test('rejects a reference that is not a loaded document: a parsed body, or an unknown field', () => {
    for (const references of [
      { x: { body: { type: 'root', children: [] } } },
      { x: { label: 'old spelling' } },
      { x: { canvas: { nodes: 'nope' } } },
    ]) {
      const parsed = canvasViewOutputSchema.safeParse({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        scene: { nodes: [], edges: [] },
        references,
      })
      expect(parsed.success, JSON.stringify(references)).toBe(false)
    }
  })

  test('returns an empty reference map for a canvas with no file nodes', async () => {
    const store = new FakeDocumentStore()
    store.documentIndex.seed({
      workspaceId: WORKSPACE_ID,
      path: 'board',
      documentId: DOCUMENT_ID,
      kind: 'spatial',
    })
    await seedDoc(store, DOCUMENT_ID, (doc) => {
      writeDocumentKind(doc, 'spatial')
      writeSpatialCanvas(doc, {
        nodes: [{ id: 't1', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'hi' }],
        edges: [],
      })
    })
    const tool = createCanvasViewTool(makeDeps(store))

    const result = await tool.execute({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID })

    expect(result.references).toEqual({})
  })

  test('refuses a markdown document instead of returning an empty scene to the widget', async () => {
    const store = new FakeDocumentStore()
    await seedDoc(store, DOCUMENT_ID, (doc) => {
      writeDocumentKind(doc, 'markdown')
      writeMarkdownBody(doc, '# Real prose')
    })
    const tool = createCanvasViewTool(makeDeps(store))

    await expect(
      tool.execute({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID }),
    ).rejects.toMatchObject({
      name: 'NotASpatialDocumentError',
      message: expect.stringMatching(/markdown.*wb_document_get/s),
    })
  })
})
