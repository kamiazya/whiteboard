import { InMemoryDocumentIndex } from '@kamiazya/whiteboard-ports/test-utils'
import { describe, expect, it } from 'vitest'
import { createServer } from '../create-server.js'
import { createInMemoryDocumentStore } from '../test-utils/in-memory-document-store.js'
import { unusedDocumentTeardown } from '../test-utils/unused-document-teardown.js'
import { wbDocumentCreate } from './document-crud.js'
import { createDocumentSetTool } from './document-set.js'
import { documentTagsOutputSchema } from './document-tags.js'

const WS = 'ws-1'

function makeDeps() {
  return {
    documentStore: createInMemoryDocumentStore(),
    blobStore: {} as never,
    documentIndex: new InMemoryDocumentIndex(),
    documentTeardown: unusedDocumentTeardown(),
  }
}

describe('GET /document-tags', () => {
  it('lists tagged markdown documents and omits tagless, spatial, and snapshotless ones', async () => {
    const deps = makeDeps()
    const create = (path: string, kind: 'markdown' | 'spatial') =>
      wbDocumentCreate(deps, { workspaceId: WS, path, kind, createWorkspace: true })
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
  })

  it('answers 404 for an unknown workspace', async () => {
    const deps = makeDeps()
    const res = await createServer(deps).app.request('/api/v1/workspaces/nope/document-tags')
    expect(res.status).toBe(404)
  })
})
