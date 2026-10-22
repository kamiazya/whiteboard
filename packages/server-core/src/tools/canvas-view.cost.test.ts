// What one `canvas_view` call costs the serving loop when the board names
// many large documents — each one twice, by id and by path. The reference
// walk is bounded by a COUNT of distinct target strings, so what it reads
// and returns is priced by the documents those strings name.

import {
  writeDocumentKind,
  writeMarkdownBody,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { fileNode } from '@kamiazya/whiteboard-model/test-utils'
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
  const nodes = []
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
  test('a hub naming large notes by id and by path: snapshot reads and characters returned', async ({
    annotate,
  }) => {
    const store = new FakeDocumentStore()
    await seedHub(store)
    const loadSnapshot = vi.spyOn(store, 'loadSnapshot')
    const tool = createCanvasViewTool(
      makeTestDeps({ documentStore: store, documentIndex: store.documentIndex }),
    )

    const started = performance.now()
    const result = await tool.execute({ workspaceId: WORKSPACE_ID, documentId: BOARD_ID })
    const wallMs = performance.now() - started

    const referenceReads = loadSnapshot.mock.calls.filter(
      ([{ docRef }]) => docRef.kind === 'document' && docRef.documentId !== BOARD_ID,
    ).length
    const returnedChars = Object.values(result.references).reduce(
      (sum, ref) => sum + (ref.body?.length ?? 0),
      0,
    )
    // The measurement, for a reader comparing runs; the assertions below pin it.
    await annotate(
      JSON.stringify({ referenceReads, returnedChars, wallMs: Math.round(wallMs) }),
      'measurement',
    )

    expect(Object.keys(result.references)).toHaveLength(NOTE_COUNT * 2)
    expect(referenceReads).toBe(NOTE_COUNT * 2)
    expect(returnedChars).toBe(NOTE_COUNT * 2 * NOTE_CHARS)
  })
})
