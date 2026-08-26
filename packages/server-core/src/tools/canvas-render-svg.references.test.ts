// `wb_scene_render`'s opt-in reference resolution: a file node pointing at a
// markdown document in the same workspace renders that document's body.
//
// Opt-in, not default, because `composeCanvasScene` also backs
// `wb_canvas_snapshot({ layout: true })`. Resolving by default would make a
// canvas's layout analysis move
// whenever a DIFFERENT document was edited, which is the property that makes
// that analysis usable as a change signal at all.
import { writeDocumentKind, writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { describe, expect, test } from 'vitest'
import { FakeDocumentStore, seedDoc } from '../test-utils/fake-document-store.js'
import { ignoredDocumentWrites } from '../test-utils/ignored-document-writes.js'
import { unusedDocumentTeardown } from '../test-utils/unused-document-teardown.js'
import { canvasRenderSvgInputSchema, createCanvasRenderSvgTool } from './canvas-render-svg.js'
import { createCanvasSnapshotTool } from './canvas-snapshot.js'

const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const NOTE_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V8'
const DIAGRAM_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V9'
const WORKSPACE_ID = 'ws-1'

function makeDeps(documentStore: FakeDocumentStore) {
  return {
    documentStore,
    blobStore: {} as never,
    documentIndex: documentStore.documentIndex,
    documentTeardown: unusedDocumentTeardown(),
    documentWritten: ignoredDocumentWrites(),
  }
}

/**
 * Seeds a workspace holding a canvas with one file node, plus the markdown
 * document it references. The markdown document is written the way
 * `wb_document_set` writes one — a single `okf-body` text node — because
 * that IS a markdown document's stored shape on this side.
 */
async function seedWorkspace(store: FakeDocumentStore, ref: string) {
  // `seed`, not `createDocument`: the index ASSIGNS an id, and these tests
  // need the reference in the file node to name the document they seeded.
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
      nodes: [{ id: 'f1', type: 'file', x: 0, y: 0, width: 400, height: 300, file: ref }],
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
          text: '# Weekly notes\n\nShipped the markdown file node.',
        },
      ],
      edges: [],
    })
  })
}

describe('wb_scene_render reference resolution', () => {
  test('renders the referenced markdown body when embedReferences is set', async () => {
    const store = new FakeDocumentStore()
    await seedWorkspace(store, NOTE_ID)
    const tool = createCanvasRenderSvgTool(makeDeps(store))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      embedReferences: true,
    })

    expect(result.svg).toContain('Weekly notes')
    expect(result.svg).toContain('Shipped')
  })

  test('resolves a reference written as a document path, not only as an id', async () => {
    const store = new FakeDocumentStore()
    await seedWorkspace(store, 'notes')
    const tool = createCanvasRenderSvgTool(makeDeps(store))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      embedReferences: true,
    })

    expect(result.svg).toContain('Weekly notes')
  })

  test('leaves the default render untouched', async () => {
    const store = new FakeDocumentStore()
    await seedWorkspace(store, NOTE_ID)
    const tool = createCanvasRenderSvgTool(makeDeps(store))

    // Through the SCHEMA, so this asserts the declared default and the
    // handler agree — calling execute with a hand-written `false` would only
    // prove the handler honours what it was handed.
    const byDefault = await tool.execute(
      canvasRenderSvgInputSchema.parse({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID }),
    )
    const explicitlyOff = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      embedReferences: false,
    })

    expect(byDefault.svg).not.toContain('Weekly notes')
    expect(explicitlyOff.svg).toBe(byDefault.svg)
  })

  test('keeps the card for a reference that resolves to a SPATIAL document', async () => {
    // The markdown seam answers for markdown documents only. A spatial
    // document is not prose, and rendering its first text node as if it
    // were would misreport what the reference points at.
    const store = new FakeDocumentStore()
    await seedWorkspace(store, DIAGRAM_ID)
    store.documentIndex.seed({
      workspaceId: WORKSPACE_ID,
      path: 'diagram',
      documentId: DIAGRAM_ID,
      kind: 'spatial',
    })
    await seedDoc(store, DIAGRAM_ID, (doc) => {
      writeDocumentKind(doc, 'spatial')
      writeSpatialCanvas(doc, {
        nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'INNER' }],
        edges: [],
      })
    })
    const tool = createCanvasRenderSvgTool(makeDeps(store))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      embedReferences: true,
    })

    expect(result.svg).not.toContain('INNER')
  })

  test('renders a dangling reference as the plain card rather than failing', async () => {
    const store = new FakeDocumentStore()
    await seedWorkspace(store, 'nowhere')
    const tool = createCanvasRenderSvgTool(makeDeps(store))

    await expect(
      tool.execute({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID, embedReferences: true }),
    ).resolves.toMatchObject({ svg: expect.stringContaining('<svg') })
  })
})

describe('reference resolution edge cases', () => {
  test('keeps a resolved NAME for an indexed document whose snapshot is gone', async () => {
    // The index and the doc store are separate: a row can outlive its
    // snapshot (an interrupted delete, a restored index). The reference is
    // still nameable even though its content is not readable, and the
    // label is strictly better than showing a raw id.
    const store = new FakeDocumentStore()
    await seedWorkspace(store, NOTE_ID)
    await store.deleteDoc({
      docRef: { kind: 'document', workspaceId: WORKSPACE_ID, documentId: NOTE_ID },
    })
    const tool = createCanvasRenderSvgTool(makeDeps(store))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      embedReferences: true,
    })

    expect(result.svg).toContain('Weekly')
    expect(result.svg).not.toContain('Weekly notes')
  })

  test('labels a reference with its document name instead of its raw id', async () => {
    // The label seam is wired from the same `references` map as the body,
    // so it needs its own assertion — a body-only test passes while the
    // label wiring is missing entirely.
    const store = new FakeDocumentStore()
    await seedWorkspace(store, NOTE_ID)
    const tool = createCanvasRenderSvgTool(makeDeps(store))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      embedReferences: true,
    })

    expect(result.svg).toContain('Weekly')
    expect(result.svg).not.toContain(NOTE_ID)
  })
})

describe('wb_scene_render input schema', () => {
  test('defaults embedReferences to false, so an existing caller keeps the pure render', () => {
    const parsed = canvasRenderSvgInputSchema.parse({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
    })
    expect(parsed.embedReferences).toBe(false)
  })

  test('rejects a non-boolean, rather than coercing it to on', () => {
    expect(
      canvasRenderSvgInputSchema.safeParse({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        embedReferences: 'yes',
      }).success,
    ).toBe(false)
  })
})

describe('wb_canvas_snapshot({ layout: true })', () => {
  // Characterization, and deliberately NOT a guard on the opt-in wiring:
  // this passes even if the analysis is wired to resolve references, because
  // `sceneDigest` reports one entry per ADDRESSABLE node — the chrome
  // shapes carrying a document id — and content laid out INSIDE a node is
  // excluded by design. So it is immune for a structural reason, which is
  // stronger than "nobody wired it".
  //
  // What it does guard is that chrome-only contract from the other side: if
  // `sceneDigest` ever started reporting laid-out content, a canvas's
  // analysis would begin moving whenever a DIFFERENT document was edited,
  // and this goes red at that moment. The opt-in itself is guarded by
  // 'leaves the default render untouched' above, which IS mutation-checked.
  test('does not move when only the referenced document changes', async () => {
    const store = new FakeDocumentStore()
    await seedWorkspace(store, NOTE_ID)
    const snapshot = createCanvasSnapshotTool(makeDeps(store))

    const before = await snapshot.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      layout: true,
    })

    // Edit ONLY the referenced document.
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
            text: '# Rewritten\n\nCompletely different content now.',
          },
        ],
        edges: [],
      })
    })

    const after = await snapshot.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      layout: true,
    })
    expect(after).toEqual(before)
  })
})
