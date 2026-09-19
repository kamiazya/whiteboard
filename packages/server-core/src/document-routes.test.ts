import { InMemoryDocumentIndex } from '@kamiazya/whiteboard-ports/test-utils'
import { describe, expect, it } from 'vitest'
import { createServer } from './create-server.js'
import { createInMemoryDocumentStore } from './test-utils/in-memory-document-store.js'
import { makeTestDeps } from './test-utils/make-test-deps.js'
import { inMemoryDocumentTeardown } from './test-utils/unused-document-teardown.js'
import {
  wbDocumentCreateOutputSchema,
  wbDocumentListOutputSchema,
} from './tools/document-crud.schemas.js'

function makeServer() {
  return createServer(
    makeTestDeps({
      documentStore: createInMemoryDocumentStore(),
      documentTeardown: inMemoryDocumentTeardown(),
    }),
  )
}

function makeApp() {
  return makeServer().app
}

describe('canvas CRUD routes', () => {
  it('POST creates a canvas and returns 201', async () => {
    const app = makeApp()
    const res = await app.request('/api/v1/workspaces/ws-1/documents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'doc-a', kind: 'spatial', createWorkspace: true }),
    })
    expect(res.status).toBe(201)
    const body = wbDocumentCreateOutputSchema.parse(await res.json())
    expect(body.path).toBe('doc-a')
    expect(typeof body.documentId).toBe('string')
  })

  it('POST with an invalid segment returns 400', async () => {
    const app = makeApp()
    const res = await app.request('/api/v1/workspaces/ws-1/documents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '-leading', kind: 'spatial' }),
    })
    expect(res.status).toBe(400)
  })

  it('POST with an invalid workspaceId (path traversal chars) returns 400', async () => {
    const app = makeApp()
    const res = await app.request('/api/v1/workspaces/..%2Ftraversal/documents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'doc-a', kind: 'spatial', createWorkspace: true }),
    })
    expect(res.status).toBe(400)
  })

  it('POST into an unknown workspace without createWorkspace returns 404', async () => {
    const app = makeApp()
    const res = await app.request('/api/v1/workspaces/typo-probe-ws/documents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'doc-a', kind: 'spatial' }),
    })
    expect(res.status).toBe(404)
  })

  it('POST creating a duplicate sibling segment returns 409', async () => {
    const app = makeApp()
    await app.request('/api/v1/workspaces/ws-1/documents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'doc-a', kind: 'spatial', createWorkspace: true }),
    })
    const res = await app.request('/api/v1/workspaces/ws-1/documents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'doc-a', kind: 'spatial', createWorkspace: true }),
    })
    expect(res.status).toBe(409)
  })

  // This route shares `wbDocumentCreate`'s semantics, so it accepts a bare
  // body for the same reason the tool does — a caller who sends prose gets a
  // note rather than a parse error about a block they never wrote.
  it('POST a markdown document whose body has no frontmatter stores it as a note', async () => {
    const app = makeApp()
    const res = await app.request('/api/v1/workspaces/ws-1/documents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: 'note',
        kind: 'markdown',
        markdown: 'no frontmatter here',
        createWorkspace: true,
      }),
    })
    expect(res.status).toBe(201)
    const { documentId } = wbDocumentCreateOutputSchema.parse(await res.json())

    const okf = await app.request(`/api/v1/workspaces/ws-1/documents/${documentId}/okf`)
    expect(okf.status).toBe(200)
    const stored = await okf.text()
    expect(stored).toContain('type: note')
    expect(stored).toContain('no frontmatter here')
  })

  // A `---` block that IS there and does not parse keeps its 400: the caller
  // wrote frontmatter and got it wrong, which is the one case the wrapper
  // above must not paper over.
  it('POST a markdown document whose frontmatter is malformed returns 400 with a reason', async () => {
    const app = makeApp()
    const res = await app.request('/api/v1/workspaces/ws-1/documents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: 'note',
        kind: 'markdown',
        markdown: '---\ntype: 7\n---\n\nbody\n',
        createWorkspace: true,
      }),
    })
    expect(res.status).toBe(400)
    // The stage is the reason; a message that dropped it would still say OKF.
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining('OKF parse failed at frontmatter-schema:'),
    })
  })

  it('POST a markdown document whose tag the workspace library forbids returns 400, not 500', async () => {
    const app = makeApp()
    // The library is a document like any other, declared through the same
    // route the refused create below uses.
    const library = [
      '---',
      'type: note',
      'facets:',
      '  visual.tags/v0:',
      '    keys:',
      '      health:',
      '        values:',
      '          ok: { color: "4" }',
      '          failing: { color: "1" }',
      '---',
      'The vocabulary this workspace holds itself to.',
    ].join('\n')
    await app.request('/api/v1/workspaces/ws-1/documents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: 'tags',
        kind: 'markdown',
        markdown: library,
        createWorkspace: true,
      }),
    })

    const res = await app.request('/api/v1/workspaces/ws-1/documents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: 'services/api',
        kind: 'markdown',
        markdown: '---\ntype: note\ntags:\n  - health:unknown\n---\nBody.',
      }),
    })

    // A well-formed request the workspace's own declaration refuses: only
    // the caller can pick an admitted value, so it is theirs to fix.
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining('health:unknown'),
    })
  })

  it('GET list returns 200 with an array', async () => {
    const app = makeApp()
    await app.request('/api/v1/workspaces/ws-1/documents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'doc-a', kind: 'spatial', createWorkspace: true }),
    })
    const res = await app.request('/api/v1/workspaces/ws-1/documents')
    expect(res.status).toBe(200)
    const body = wbDocumentListOutputSchema.parse(await res.json())
    expect(body.documents).toHaveLength(1)
  })

  it('GET list into an unknown workspace returns 404', async () => {
    const app = makeApp()
    const res = await app.request('/api/v1/workspaces/typo-probe-ws/documents')
    expect(res.status).toBe(404)
  })

  it('GET by id returns 200 after create and 404 for unknown', async () => {
    const app = makeApp()
    const createRes = await app.request('/api/v1/workspaces/ws-1/documents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'doc-a', kind: 'spatial', createWorkspace: true }),
    })
    const { documentId } = wbDocumentCreateOutputSchema.parse(await createRes.json())

    const getRes = await app.request(`/api/v1/workspaces/ws-1/documents/${documentId}`)
    expect(getRes.status).toBe(200)

    const notFoundRes = await app.request(
      '/api/v1/workspaces/ws-1/documents/01ARZ3NDEKTSV4RRFFQ69G5FAV',
    )
    expect(notFoundRes.status).toBe(404)
  })

  it('DELETE returns 200 after create and 404 for unknown', async () => {
    const app = makeApp()
    const createRes = await app.request('/api/v1/workspaces/ws-1/documents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'doc-a', kind: 'spatial', createWorkspace: true }),
    })
    const { documentId } = wbDocumentCreateOutputSchema.parse(await createRes.json())

    const deleteRes = await app.request(`/api/v1/workspaces/ws-1/documents/${documentId}`, {
      method: 'DELETE',
    })
    expect(deleteRes.status).toBe(200)

    const notFoundRes = await app.request(`/api/v1/workspaces/ws-1/documents/${documentId}`, {
      method: 'DELETE',
    })
    expect(notFoundRes.status).toBe(404)
  })
})

describe('canvas OKF read route', () => {
  it('GET .../documents/:documentId/okf returns the exported OKF markdown', async () => {
    const { app, tools } = makeServer()
    const createRes = await app.request('/api/v1/workspaces/ws-1/documents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'doc-a', kind: 'markdown', createWorkspace: true }),
    })
    const created = wbDocumentCreateOutputSchema.parse(await createRes.json())
    await tools.workspaceEdit.execute({
      workspaceId: 'ws-1',
      ops: [
        {
          op: 'document.set',
          documentId: created.documentId,
          markdown: '---\ntype: note\ntitle: Doc A\n---\n\nHello tree',
        },
      ],
    })

    const res = await app.request(`/api/v1/workspaces/ws-1/documents/${created.documentId}/okf`)
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
    const { app } = createServer(makeTestDeps({ documentStore: store, documentIndex }))
    await documentIndex.createWorkspace({ workspaceId: 'ws-1' })
    const { documentId } = await documentIndex.createDocument({
      workspaceId: 'ws-1',
      path: 'orphan',
      kind: 'spatial',
    })

    const res = await app.request(`/api/v1/workspaces/ws-1/documents/${documentId}/okf`)
    expect(res.status).toBe(404)
  })

  it('GET okf for an unknown canvas returns 404', async () => {
    const app = makeApp()
    const res = await app.request(
      '/api/v1/workspaces/ws-1/documents/01ARZ3NDEKTSV4RRFFQ69G5FAV/okf',
    )
    expect(res.status).toBe(404)
  })
})
