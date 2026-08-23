import { writeDocumentKind, writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { describe, expect, test } from 'vitest'
import type { ViewportRequest } from '../server-deps.js'
import {
  FakeDocumentStore,
  registerDocumentInWorkspace,
  seedDoc,
} from '../test-utils/fake-document-store.js'
import { ignoredDocumentWrites } from '../test-utils/ignored-document-writes.js'
import { unusedDocumentTeardown } from '../test-utils/unused-document-teardown.js'
import { createViewportSetTool } from './viewport-set.js'

const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
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

async function seed(store: FakeDocumentStore): Promise<void> {
  await seedDoc(store, DOCUMENT_ID, (doc) => {
    writeDocumentKind(doc, 'spatial')
    writeSpatialCanvas(doc, {
      nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'A' }],
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
      elementIds: ['a'],
      animate: false,
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
      elementIds: ['a'],
      animate: false,
      zoom: 1.5,
    })
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
})
