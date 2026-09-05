// `wb_scene_render` on a MARKDOWN document, and the reference forms the
// web preview already draws: a canvas behind `![[path]]` as a miniature, a
// `#fragment` narrowing either kind to the heading or group it names, and a
// `fragment` input that renders one part of a document on its own.
import {
  writeDocumentKind,
  writeMarkdownBody,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { describe, expect, test } from 'vitest'
import type { ServerDeps } from '../server-deps.js'
import { FakeDocumentStore, seedDoc } from '../test-utils/fake-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { createCanvasRenderSvgTool } from './canvas-render-svg.js'

const NOTE_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V8'
const BOARD_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V9'
const WORKSPACE_ID = 'ws-1'

function makeDeps(documentStore: FakeDocumentStore): ServerDeps {
  return makeTestDeps({ documentStore, documentIndex: documentStore.documentIndex })
}

/**
 * A note whose body embeds a board by PATH and a section of itself would be
 * a cycle, so the section case embeds a second heading of the same note
 * through the board's own text — kept simple: the note has two sections and
 * a board embed; the board has a labelled group and a node outside it.
 */
async function seedWorkspace(store: FakeDocumentStore, noteBody: string) {
  store.documentIndex.seed({
    workspaceId: WORKSPACE_ID,
    path: 'notes/plan',
    documentId: NOTE_ID,
    kind: 'markdown',
    name: 'The Plan',
  })
  store.documentIndex.seed({
    workspaceId: WORKSPACE_ID,
    path: 'boards/roadmap',
    documentId: BOARD_ID,
    kind: 'spatial',
    name: 'Roadmap',
  })
  await seedDoc(store, NOTE_ID, (doc) => {
    writeDocumentKind(doc, 'markdown')
    writeMarkdownBody(doc, noteBody)
  })
  await seedDoc(store, BOARD_ID, (doc) => {
    writeDocumentKind(doc, 'spatial')
    writeSpatialCanvas(doc, {
      nodes: [
        { id: 'g', type: 'group', x: 0, y: 0, width: 400, height: 200, label: 'Launch' },
        { id: 'in', type: 'text', x: 10, y: 10, width: 200, height: 60, text: 'LAUNCH-NODE' },
        { id: 'out', type: 'text', x: 900, y: 900, width: 200, height: 60, text: 'OTHER-NODE' },
      ],
      edges: [],
    })
  })
}

const NOTE = '## Plan\n\nplan body\n\n## Launch\n\n![[boards/roadmap#Launch]]\n\nlaunch body\n'

describe('wb_scene_render on a markdown document', () => {
  test('renders the body as a document scene', async () => {
    const store = new FakeDocumentStore()
    await seedWorkspace(store, NOTE)
    const tool = createCanvasRenderSvgTool(makeDeps(store))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: NOTE_ID,
      embedReferences: false,
    })

    expect(result.svg).toContain('plan body')
    expect(result.svg).toContain('launch body')
    expect(result.width).toBeGreaterThan(0)
    expect(result.height).toBeGreaterThan(0)
  })

  test('with embedReferences, ![[path#Group]] draws that group of the board under its name', async () => {
    const store = new FakeDocumentStore()
    await seedWorkspace(store, NOTE)
    const tool = createCanvasRenderSvgTool(makeDeps(store))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: NOTE_ID,
      embedReferences: true,
    })

    expect(result.svg).toContain('LAUNCH-NODE')
    expect(result.svg).not.toContain('OTHER-NODE')
    expect(result.svg).toContain('Roadmap › Launch')
  })

  test('without embedReferences the embed stays a placeholder naming its address', async () => {
    const store = new FakeDocumentStore()
    await seedWorkspace(store, NOTE)
    const tool = createCanvasRenderSvgTool(makeDeps(store))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: NOTE_ID,
      embedReferences: false,
    })

    expect(result.svg).not.toContain('LAUNCH-NODE')
    expect(result.svg).toContain('boards/roadmap#Launch')
  })

  test('a `fragment` renders one section of the note and nothing else', async () => {
    const store = new FakeDocumentStore()
    await seedWorkspace(store, NOTE)
    const tool = createCanvasRenderSvgTool(makeDeps(store))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: NOTE_ID,
      embedReferences: false,
      fragment: 'Plan',
    })

    expect(result.svg).toContain('plan body')
    expect(result.svg).not.toContain('launch body')
  })

  test('a note embedding a section of another note lays out that section only', async () => {
    const store = new FakeDocumentStore()
    await seedWorkspace(store, '## Alpha\n\nalpha body\n\n## Beta\n\nbeta body\n')
    const READER_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8VA'
    store.documentIndex.seed({
      workspaceId: WORKSPACE_ID,
      path: 'notes/reader',
      documentId: READER_ID,
      kind: 'markdown',
    })
    await seedDoc(store, READER_ID, (doc) => {
      writeDocumentKind(doc, 'markdown')
      writeMarkdownBody(doc, 'intro\n\n![[notes/plan#Beta]]\n')
    })
    const tool = createCanvasRenderSvgTool(makeDeps(store))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: READER_ID,
      embedReferences: true,
    })

    expect(result.svg).toContain('beta body')
    expect(result.svg).not.toContain('alpha body')
  })
})

describe('wb_scene_render `fragment` on a spatial document', () => {
  test('renders the named group with its members, and nothing outside it', async () => {
    const store = new FakeDocumentStore()
    await seedWorkspace(store, NOTE)
    const tool = createCanvasRenderSvgTool(makeDeps(store))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: BOARD_ID,
      embedReferences: false,
      fragment: 'Launch',
    })

    expect(result.svg).toContain('LAUNCH-NODE')
    expect(result.svg).not.toContain('OTHER-NODE')
  })

  test('a fragment the document does not hold is refused, naming it', async () => {
    const store = new FakeDocumentStore()
    await seedWorkspace(store, NOTE)
    const tool = createCanvasRenderSvgTool(makeDeps(store))

    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: BOARD_ID,
        embedReferences: false,
        fragment: 'Nowhere',
      }),
    ).rejects.toThrow(/Nowhere/)
    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: NOTE_ID,
        embedReferences: false,
        fragment: 'Nowhere',
      }),
    ).rejects.toThrow(/Nowhere/)
  })
})
