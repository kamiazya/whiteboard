import {
  writeCoreFacets,
  writeDocumentKind,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { createServer } from '../create-server.js'
import type { ServerDeps } from '../server-deps.js'
import { FakeDocumentStore, seedDoc } from '../test-utils/fake-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { wbDocumentCreate } from './document-crud.js'
import { createDocumentSetTool } from './document-set.js'
import { computeDocumentTags, documentTagsOutputSchema } from './document-tags.js'

const WS = 'ws-1'

function makeDeps(): ServerDeps {
  return makeTestDeps()
}

describe('GET /document-tags', () => {
  it('lists tagged markdown documents and omits tagless, spatial, and snapshotless ones', async () => {
    const deps = makeDeps()
    // The workspace exists because this fixture says so, not as a side effect
    // of the first create: creating one is ADR-0019's MINT boundary, which
    // keys it by a fresh ULID and would leave the literal below naming nothing.
    await deps.documentIndex.createWorkspace({ workspaceId: WS })
    const create = (path: string, kind: 'markdown' | 'spatial') =>
      wbDocumentCreate(deps, { workspaceId: WS, path, kind })
    const tagged = await create('tagged', 'markdown')
    const plain = await create('plain', 'markdown')
    await create('board', 'spatial')
    await create('empty', 'markdown') // never written: no snapshot
    const set = createDocumentSetTool(deps)
    await set.execute({
      workspaceId: WS,
      documentId: tagged.documentId,
      markdown: '---\ntype: note\ntags:\n  - release\n  - q3\n---\nbody',
    })
    await set.execute({
      workspaceId: WS,
      documentId: plain.documentId,
      markdown: '---\ntype: note\n---\nno tags here',
    })

    const res = await createServer(deps).app.request(`/api/v1/workspaces/${WS}/document-tags`)
    expect(res.status).toBe(200)
    const out = documentTagsOutputSchema.parse(await res.json())
    expect(out.documents).toEqual([{ documentId: tagged.documentId, tags: ['release', 'q3'] }])
    expect(out.inUse).toEqual([
      { tag: 'q3', documents: 1, boards: 0, nodes: 0, edges: 0 },
      { tag: 'release', documents: 1, boards: 0, nodes: 0, edges: 0 },
    ])
  })

  it('answers 404 for an unknown workspace', async () => {
    const deps = makeDeps()
    const res = await createServer(deps).app.request('/api/v1/workspaces/nope/document-tags')
    expect(res.status).toBe(404)
  })
})

const WORKSPACE_ID = 'ws-tags'
const NOTE_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8W1'
const BOARD_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8W2'

describe('the workspace tag projection', () => {
  const seeded = async () => {
    const store = new FakeDocumentStore()
    await seedDoc(store, NOTE_ID, (doc) => {
      writeDocumentKind(doc, 'markdown')
      writeCoreFacets(doc, { type: 'note', tags: ['retro'] })
    })
    store.documentIndex.seed({
      workspaceId: WORKSPACE_ID,
      documentId: NOTE_ID,
      path: 'a',
      kind: 'markdown',
    })
    await seedDoc(store, BOARD_ID, (doc) => {
      writeDocumentKind(doc, 'spatial')
      writeSpatialCanvas(doc, {
        nodes: [
          textNode({
            id: 'a',
            text: 'A',
            x: 0,
            y: 0,
            width: 10,
            height: 10,
            tags: ['health:failing'],
          }),
        ],
        edges: [],
        tags: ['phase:design'],
      })
    })
    store.documentIndex.seed({
      workspaceId: WORKSPACE_ID,
      documentId: BOARD_ID,
      path: 'b',
      kind: 'spatial',
    })
    return makeTestDeps({ documentStore: store, documentIndex: store.documentIndex })
  }

  it('lists a board by its own tags beside the notes, and the vocabulary in use with counts', async () => {
    const out = await computeDocumentTags(await seeded(), { workspaceId: WORKSPACE_ID })
    expect(out.documents).toEqual([
      { documentId: NOTE_ID, tags: ['retro'] },
      { documentId: BOARD_ID, tags: ['phase:design'] },
    ])
    expect(out.inUse).toEqual([
      {
        tag: 'health:failing',
        key: 'health',
        value: 'failing',
        documents: 0,
        boards: 0,
        nodes: 1,
        edges: 0,
      },
      {
        tag: 'phase:design',
        key: 'phase',
        value: 'design',
        documents: 0,
        boards: 1,
        nodes: 0,
        edges: 0,
      },
      { tag: 'retro', documents: 1, boards: 0, nodes: 0, edges: 0 },
    ])
  })
})
