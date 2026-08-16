import { InMemoryDocumentIndex } from '@kamiazya/whiteboard-canvas-ports/test-utils'
import { describe, expect, it } from 'vitest'
import { createServer } from './create-server.js'
import { createInMemoryDocumentStore } from './test-utils/in-memory-document-store.js'
import { createCanvasOutputSchema, listCanvasesOutputSchema } from './tools/canvas-crud.schemas.js'

function makeServer() {
  return createServer({
    documentStore: createInMemoryDocumentStore(),
    blobStore: {} as never,
    documentIndex: new InMemoryDocumentIndex(),
  })
}

function makeApp() {
  return makeServer().app
}

describe('canvas CRUD routes', () => {
  it('POST creates a canvas and returns 201', async () => {
    const app = makeApp()
    const res = await app.request('/api/v1/workspaces/ws-1/canvases', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'doc-a', kind: 'spatial', createWorkspace: true }),
    })
    expect(res.status).toBe(201)
    const body = createCanvasOutputSchema.parse(await res.json())
    expect(body.path).toBe('doc-a')
    expect(typeof body.canvasId).toBe('string')
  })

  it('POST with an invalid segment returns 400', async () => {
    const app = makeApp()
    const res = await app.request('/api/v1/workspaces/ws-1/canvases', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '-leading', kind: 'spatial' }),
    })
    expect(res.status).toBe(400)
  })

  it('POST with an invalid workspaceId (path traversal chars) returns 400', async () => {
    const app = makeApp()
    const res = await app.request('/api/v1/workspaces/..%2Ftraversal/canvases', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'doc-a', kind: 'spatial', createWorkspace: true }),
    })
    expect(res.status).toBe(400)
  })

  it('POST into an unknown workspace without createWorkspace returns 404', async () => {
    const app = makeApp()
    const res = await app.request('/api/v1/workspaces/typo-probe-ws/canvases', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'doc-a', kind: 'spatial' }),
    })
    expect(res.status).toBe(404)
  })

  it('POST creating a duplicate sibling segment returns 409', async () => {
    const app = makeApp()
    await app.request('/api/v1/workspaces/ws-1/canvases', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'doc-a', kind: 'spatial', createWorkspace: true }),
    })
    const res = await app.request('/api/v1/workspaces/ws-1/canvases', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'doc-a', kind: 'spatial', createWorkspace: true }),
    })
    expect(res.status).toBe(409)
  })

  it('GET list returns 200 with an array', async () => {
    const app = makeApp()
    await app.request('/api/v1/workspaces/ws-1/canvases', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'doc-a', kind: 'spatial', createWorkspace: true }),
    })
    const res = await app.request('/api/v1/workspaces/ws-1/canvases')
    expect(res.status).toBe(200)
    const body = listCanvasesOutputSchema.parse(await res.json())
    expect(body.canvases).toHaveLength(1)
  })

  it('GET list into an unknown workspace returns 404', async () => {
    const app = makeApp()
    const res = await app.request('/api/v1/workspaces/typo-probe-ws/canvases')
    expect(res.status).toBe(404)
  })

  it('GET by id returns 200 after create and 404 for unknown', async () => {
    const app = makeApp()
    const createRes = await app.request('/api/v1/workspaces/ws-1/canvases', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'doc-a', kind: 'spatial', createWorkspace: true }),
    })
    const { canvasId } = createCanvasOutputSchema.parse(await createRes.json())

    const getRes = await app.request(`/api/v1/workspaces/ws-1/canvases/${canvasId}`)
    expect(getRes.status).toBe(200)

    const notFoundRes = await app.request(
      '/api/v1/workspaces/ws-1/canvases/01ARZ3NDEKTSV4RRFFQ69G5FAV',
    )
    expect(notFoundRes.status).toBe(404)
  })

  it('DELETE returns 200 after create and 404 for unknown', async () => {
    const app = makeApp()
    const createRes = await app.request('/api/v1/workspaces/ws-1/canvases', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'doc-a', kind: 'spatial', createWorkspace: true }),
    })
    const { canvasId } = createCanvasOutputSchema.parse(await createRes.json())

    const deleteRes = await app.request(`/api/v1/workspaces/ws-1/canvases/${canvasId}`, {
      method: 'DELETE',
    })
    expect(deleteRes.status).toBe(200)

    const notFoundRes = await app.request(`/api/v1/workspaces/ws-1/canvases/${canvasId}`, {
      method: 'DELETE',
    })
    expect(notFoundRes.status).toBe(404)
  })
})

describe('canvas OKF read route', () => {
  it('GET .../canvases/:canvasId/okf returns the exported OKF markdown', async () => {
    const { app, tools } = makeServer()
    const createRes = await app.request('/api/v1/workspaces/ws-1/canvases', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'doc-a', kind: 'markdown', createWorkspace: true }),
    })
    const created = createCanvasOutputSchema.parse(await createRes.json())
    await tools.documentSet.execute({
      workspaceId: 'ws-1',
      canvasId: created.canvasId,
      markdown: '---\ntype: note\ntitle: Doc A\n---\n\nHello tree',
    })

    const res = await app.request(`/api/v1/workspaces/ws-1/canvases/${created.canvasId}/okf`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { markdown: string }
    expect(body.markdown).toContain('Hello tree')
  })

  it('GET okf for an indexed document with no stored bytes returns 404', async () => {
    // Creation now writes the document, so this state is no longer reachable
    // by creating and not writing — it has to be built through the index
    // alone. It is still worth guarding: a document whose bytes were deleted,
    // or one written by an older build that created placements lazily, lands
    // here.
    const store = createInMemoryDocumentStore()
    const documentIndex = new InMemoryDocumentIndex()
    const { app } = createServer({ documentStore: store, blobStore: {} as never, documentIndex })
    await documentIndex.createWorkspace({ workspaceId: 'ws-1' })
    const { canvasId } = await documentIndex.createDocument({
      workspaceId: 'ws-1',
      path: 'orphan',
      kind: 'spatial',
    })

    const res = await app.request(`/api/v1/workspaces/ws-1/canvases/${canvasId}/okf`)
    expect(res.status).toBe(404)
  })

  it('GET okf for an unknown canvas returns 404', async () => {
    const app = makeApp()
    const res = await app.request('/api/v1/workspaces/ws-1/canvases/01ARZ3NDEKTSV4RRFFQ69G5FAV/okf')
    expect(res.status).toBe(404)
  })
})
