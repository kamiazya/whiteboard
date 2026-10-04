import { writeDocumentKind, writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, test } from 'vitest'
import type { ServerDeps } from '../server-deps.js'
import {
  FakeDocumentStore,
  registerDocumentInWorkspace,
  seedDoc,
} from '../test-utils/fake-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import type { ViewportRequest } from '../viewport-request.js'
import { createViewportSetTool } from './viewport-set.js'

const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'

function makeDeps(documentStore: FakeDocumentStore): ServerDeps {
  return makeTestDeps({
    documentStore: documentStore,
    documentIndex: documentStore.documentIndex,
  })
}

async function seed(store: FakeDocumentStore): Promise<void> {
  await seedDoc(store, DOCUMENT_ID, (doc) => {
    writeDocumentKind(doc, 'spatial')
    writeSpatialCanvas(doc, {
      nodes: [textNode({ id: 'a', x: 0, y: 0, width: 10, height: 10, text: 'A' })],
      edges: [],
    })
  })
  await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
}

describe('wb_viewport_set tool', () => {
  test('forwards every viewport parameter to the watching browser', async () => {
    const store = new FakeDocumentStore()
    await seed(store)
    const sent: ViewportRequest[] = []
    const tool = createViewportSetTool({
      ...makeDeps(store),
      clientNotifier: {
        agentActivity: () => {},
        versionCreated: () => {},
        restoreProgress: () => {},
        requestViewport: async (request) => {
          sent.push(request)
          return true
        },
      },
    })

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'move',
      scrollX: 40,
      scrollY: -20,
      zoom: 1.5,
    })

    expect(result).toEqual({ documentId: DOCUMENT_ID, delivered: true })
    expect(sent).toHaveLength(1)
    // Field-by-field rather than a spread: a parameter silently dropped here
    // reaches the browser as "use your default", which looks like the tool
    // worked and moved the view somewhere else.
    expect(sent[0]).toMatchObject({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'move',
      scrollX: 40,
      scrollY: -20,
      zoom: 1.5,
    })
  })

  test('forwards the elements a fit frames', async () => {
    const store = new FakeDocumentStore()
    await seed(store)
    const sent: ViewportRequest[] = []
    const tool = createViewportSetTool({
      ...makeDeps(store),
      clientNotifier: {
        agentActivity: () => {},
        versionCreated: () => {},
        restoreProgress: () => {},
        requestViewport: async (request) => {
          sent.push(request)
          return true
        },
      },
    })

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'fit',
      elementIds: ['a'],
    })

    expect(sent[0]).toMatchObject({ mode: 'fit', elementIds: ['a'] })
  })

  test.each([
    [['zzz']],
    [['a', 'zzz']],
  ])('refuses elementIds naming a node that is not on the canvas, whether or not a browser is watching (%j)', async (elementIds) => {
    // A typo'd id would otherwise frame nothing and still answer delivered,
    // and with no browser open it would read the same as a correct id.
    const store = new FakeDocumentStore()
    await seed(store)
    const sent: ViewportRequest[] = []
    const watched = createViewportSetTool({
      ...makeDeps(store),
      clientNotifier: {
        agentActivity: () => {},
        versionCreated: () => {},
        restoreProgress: () => {},
        requestViewport: async (request) => {
          sent.push(request)
          return true
        },
      },
    })
    const headless = createViewportSetTool(makeDeps(store))
    const input = { workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID, elementIds }

    await expect(watched.execute(input)).rejects.toThrow(/zzz/)
    await expect(headless.execute(input)).rejects.toThrow(/zzz/)
    expect(sent).toEqual([])
  })

  test('reports delivered:false rather than failing when no browser is watching', async () => {
    // A headless daemon is the normal case, not an error — an agent that
    // cannot tell the difference would treat every headless run as broken.
    const store = new FakeDocumentStore()
    await seed(store)
    const tool = createViewportSetTool({
      ...makeDeps(store),
      clientNotifier: {
        agentActivity: () => {},
        versionCreated: () => {},
        restoreProgress: () => {},
        requestViewport: async () => false,
      },
    })

    const result = await tool.execute({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID })

    expect(result).toEqual({ documentId: DOCUMENT_ID, delivered: false })
  })

  test('reports delivered:false when the server has no notifier wired at all', async () => {
    const store = new FakeDocumentStore()
    await seed(store)
    const tool = createViewportSetTool(makeDeps(store))

    const result = await tool.execute({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID })

    expect(result).toEqual({ documentId: DOCUMENT_ID, delivered: false })
  })

  test('refuses a document the workspace does not own', async () => {
    // Without this, an agent could nudge the viewport of a document in
    // someone else's workspace by guessing an id.
    const store = new FakeDocumentStore()
    await seedDoc(store, DOCUMENT_ID, (doc) => {
      writeDocumentKind(doc, 'spatial')
    })
    const tool = createViewportSetTool(makeDeps(store))

    await expect(
      tool.execute({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID }),
    ).rejects.toMatchObject({ name: 'WorkspaceDocumentNotFoundError' })
  })

  test('refuses a markdown document by name rather than answering delivered:false', async () => {
    // delivered:false means "no browser is open", so a caller told that about a
    // document with no viewport would wait for a browser that cannot help.
    const store = new FakeDocumentStore()
    await seedDoc(store, DOCUMENT_ID, (doc) => {
      writeDocumentKind(doc, 'markdown')
    })
    store.documentIndex.seed({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      path: 'note',
      kind: 'markdown',
    })
    const tool = createViewportSetTool(makeDeps(store))

    await expect(
      tool.execute({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID }),
    ).rejects.toThrow(`Document ${DOCUMENT_ID} is a markdown document`)
  })
})

describe('wb_viewport_set input', () => {
  const routing = { workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID }
  const { inputSchema } = createViewportSetTool(makeTestDeps())

  // The browser applies exactly one of the two: fit reads elementIds, move
  // reads scrollX/scrollY/zoom, and what the other half names it drops while
  // the tool answers delivered:true.
  test.each([
    ['move beside elementIds', { mode: 'move', elementIds: ['a'] }, /elementIds/],
    ['move beside an empty elementIds', { mode: 'move', elementIds: [] }, /elementIds/],
    ['fit beside a zoom', { mode: 'fit', zoom: 2 }, /fit/],
    ['fit beside a scroll offset', { mode: 'fit', scrollX: 5 }, /fit/],
    ['elementIds beside a zoom, mode omitted', { elementIds: ['a'], zoom: 2 }, /elementIds/],
    ['elementIds beside a scroll offset', { elementIds: ['a'], scrollY: 5 }, /elementIds/],
  ])('refuses %s, which the browser would half ignore', (_name, params, message) => {
    const result = inputSchema.safeParse({ ...routing, ...params })
    expect(result.success).toBe(false)
    expect(JSON.stringify(result.error?.issues)).toMatch(message)
  })

  test.each([
    ['nothing: fit the whole board', {}],
    ['a fit of named elements', { mode: 'fit', elementIds: ['a'] }],
    ['a bare fit', { mode: 'fit' }],
    ['a bare move, to the origin at actual size', { mode: 'move' }],
    ['a move to a position and zoom', { mode: 'move', scrollX: 1, scrollY: 2, zoom: 2 }],
    ['a lone zoom, mode omitted', { zoom: 2 }],
    ['a lone scroll offset, mode omitted', { scrollX: 3 }],
  ])('accepts %s', (_name, params) => {
    expect(inputSchema.safeParse({ ...routing, ...params }).success).toBe(true)
  })
})
