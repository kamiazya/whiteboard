// What one `canvas_view` call costs the serving loop when the board names
// many large documents — each one twice, by id and by path. The walk's
// target COUNT does not bound this, since a target is priced by the document
// it names; what does is one read per document and the content budget.

import {
  REFERENCE_CHARS_BUDGET,
  REFERENCE_ELEMENTS_BUDGET,
} from '@kamiazya/whiteboard-canvas-render'
import {
  writeDocumentKind,
  writeMarkdownBody,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { fileNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, test, vi } from 'vitest'
import { FakeDocumentStore, placeUnlessPlaced, seedDoc } from '../test-utils/fake-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { createCanvasViewTool } from './canvas-view.js'

const WORKSPACE_ID = 'ws-cost'
const BOARD_ID = '01H8XJZ9K5N4M3P2Q1R0S9T800'
const NOTE_COUNT = 16
const NOTE_CHARS = 200_000

function noteId(i: number): string {
  return `01H8XJZ9K5N4M3P2Q1R0S9T9${String(i).padStart(2, '0')}`.replace(/[ILOU]/g, 'A')
}

async function seedHub(store: FakeDocumentStore): Promise<void> {
  store.documentIndex.seed({
    workspaceId: WORKSPACE_ID,
    path: 'hub',
    documentId: BOARD_ID,
    kind: 'spatial',
  })
  const nodes: SpatialCanvas['nodes'][number][] = []
  for (let i = 0; i < NOTE_COUNT; i += 1) {
    const id = noteId(i)
    const path = `note-${i}`
    store.documentIndex.seed({ workspaceId: WORKSPACE_ID, path, documentId: id, kind: 'markdown' })
    await seedDoc(store, id, (doc) => {
      writeDocumentKind(doc, 'markdown')
      writeMarkdownBody(doc, `${i}`.padEnd(NOTE_CHARS, 'x'))
    })
    nodes.push(fileNode({ id: `id-${i}`, x: i * 400, y: 0, width: 320, height: 220, file: id }))
    nodes.push(
      fileNode({ id: `path-${i}`, x: i * 400, y: 300, width: 320, height: 220, file: path }),
    )
  }
  await seedDoc(store, BOARD_ID, (doc) => {
    writeDocumentKind(doc, 'spatial')
    writeSpatialCanvas(doc, { nodes, edges: [] })
  })
  await placeUnlessPlaced(store, WORKSPACE_ID, BOARD_ID)
}

describe('canvas_view reference cost', () => {
  test('a hub naming large notes by id and by path: snapshot reads and characters returned', async () => {
    const store = new FakeDocumentStore()
    await seedHub(store)
    const loadSnapshot = vi.spyOn(store, 'loadSnapshot')
    const tool = createCanvasViewTool(
      makeTestDeps({ documentStore: store, documentIndex: store.documentIndex }),
    )

    const result = await tool.execute({ workspaceId: WORKSPACE_ID, documentId: BOARD_ID })

    const referenceReads = loadSnapshot.mock.calls.filter(
      ([{ docRef }]) => docRef.kind === 'document' && docRef.documentId !== BOARD_ID,
    ).length
    const returnedChars = Object.values(result.references).reduce(
      (sum, ref) => sum + (ref.body?.length ?? 0),
      0,
    )
    // Every spelling still answers, so each node keeps its label.
    expect(Object.keys(result.references)).toHaveLength(NOTE_COUNT * 2)
    expect(Object.values(result.references).every((ref) => ref.documentId !== undefined)).toBe(true)
    // The notes that fit the budget whole, then one read that did not fit and
    // closed it; both spellings of a note share its one read.
    const admitted = Math.floor(REFERENCE_CHARS_BUDGET / NOTE_CHARS)
    expect(admitted).toBeLessThan(NOTE_COUNT)
    expect(referenceReads).toBe(admitted + 1)
    expect(returnedChars).toBe(2 * admitted * NOTE_CHARS)
  })

  test('a referenced board past the element budget arrives as its name, not its canvas', async () => {
    const store = new FakeDocumentStore()
    const boardNodes = Math.ceil(REFERENCE_ELEMENTS_BUDGET / 2.5)
    const boards = [0, 1, 2].map(noteId)
    store.documentIndex.seed({
      workspaceId: WORKSPACE_ID,
      path: 'hub',
      documentId: BOARD_ID,
      kind: 'spatial',
    })
    for (const [i, id] of boards.entries()) {
      store.documentIndex.seed({
        workspaceId: WORKSPACE_ID,
        path: `board-${i}`,
        documentId: id,
        kind: 'spatial',
      })
      await seedDoc(store, id, (doc) => {
        writeDocumentKind(doc, 'spatial')
        writeSpatialCanvas(doc, {
          nodes: Array.from({ length: boardNodes }, (_, n) =>
            textNode({ id: `n${n}`, x: n * 20, y: 0, width: 10, height: 10, text: 'a' }),
          ),
          edges: [],
        })
      })
    }
    await seedDoc(store, BOARD_ID, (doc) => {
      writeDocumentKind(doc, 'spatial')
      writeSpatialCanvas(doc, {
        nodes: boards.map((file, i) =>
          fileNode({ id: `f${i}`, x: i * 400, y: 0, width: 320, height: 220, file }),
        ),
        edges: [],
      })
    })
    await placeUnlessPlaced(store, WORKSPACE_ID, BOARD_ID)
    const tool = createCanvasViewTool(
      makeTestDeps({ documentStore: store, documentIndex: store.documentIndex }),
    )

    const result = await tool.execute({ workspaceId: WORKSPACE_ID, documentId: BOARD_ID })

    expect(boards.map((id) => result.references[id]?.canvas?.nodes?.length)).toEqual([
      boardNodes,
      boardNodes,
      undefined,
    ])
    expect(result.references[boards[2] as string]).toEqual({
      documentId: boards[2],
      name: 'board-2',
    })
  })
})
