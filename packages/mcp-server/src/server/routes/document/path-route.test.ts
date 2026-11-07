import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { resolvingDocumentIds } from '../_test-helpers.js'
import { onDocumentAction, onDocumentFile, onDocumentRoute } from './path-route.js'

const WS = '01TFTP6SMY23MTM63TK63WD2YX'
const DOC = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const UNKNOWN = '01ARZ3NDEKTSV4RRFFQ69G5FAW'

/** An app whose index holds one document, resolved once per request as the router mounts it. */
function appOver(held: Record<string, { path: string }>) {
  return resolvingDocumentIds(new Hono(), held)
}

const url = (documentId: string, suffix = '') =>
  `/api/workspaces/${WS}/documents/${documentId}${suffix}`

describe('onDocumentAction', () => {
  it('hands the handler the placement the id resolves to', async () => {
    const app = appOver({ [DOC]: { path: 'notes/2026/plan' } })
    onDocumentAction(app, 'get', 'snapshot', (c, workspaceId, path) =>
      c.json({ workspaceId, path }),
    )
    const res = await app.request(url(DOC, '/snapshot'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ workspaceId: WS, path: 'notes/2026/plan' })
  })

  it('answers 404 in the error contract for an id the index does not hold', async () => {
    const app = appOver({})
    onDocumentAction(app, 'get', 'snapshot', (c) => c.json({ hit: true }))
    const res = await app.request(url(UNKNOWN, '/snapshot'))
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: 'not_found' })
  })

  it('falls through on a sibling action so the sibling gets its turn', async () => {
    const app = appOver({ [DOC]: { path: 'doc' } })
    onDocumentAction(app, 'get', 'client-count', (c) => c.json({ hit: 'client-count' }))
    onDocumentAction(app, 'get', 'snapshot', (c) => c.json({ hit: 'snapshot' }))
    expect(await (await app.request(url(DOC, '/snapshot'))).json()).toEqual({ hit: 'snapshot' })
  })

  it('is not the route for a segment that is not a document id', async () => {
    // The path family that once shared this grammar is retired: a document
    // path under `/documents/` names nothing and reaches no handler.
    const app = appOver({ [DOC]: { path: 'snapshot' } })
    onDocumentAction(app, 'get', 'snapshot', (c) => c.json({ hit: true }))
    expect((await app.request(url('notes%2Fplan', '/snapshot'))).status).toBe(404)
    expect((await app.request(url('snapshot', '/snapshot'))).status).toBe(404)
  })

  it("runs a route's middleware only for its own action", async () => {
    const app = appOver({ [DOC]: { path: 'doc' } })
    const ran: string[] = []
    onDocumentAction(
      app,
      'post',
      'export',
      (c) => c.json({ hit: 'export' }),
      async (_c, next) => {
        ran.push('export middleware')
        await next()
      },
    )
    onDocumentAction(app, 'post', 'export-svg', (c) => c.json({ hit: 'export-svg' }))

    const svg = await app.request(url(DOC, '/export-svg'), { method: 'POST' })
    expect(await svg.json()).toEqual({ hit: 'export-svg' })
    expect(ran).toEqual([])

    const exported = await app.request(url(DOC, '/export'), { method: 'POST' })
    expect(await exported.json()).toEqual({ hit: 'export' })
    expect(ran).toEqual(['export middleware'])
  })
})

describe('onDocumentFile', () => {
  it('hands the handler the file id beside the resolved placement', async () => {
    const app = appOver({ [DOC]: { path: 'a/file/b' } })
    onDocumentFile(app, 'get', (c, workspaceId, path, fileId) =>
      c.json({ workspaceId, path, fileId }),
    )
    const res = await app.request(url(DOC, '/files/c'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ workspaceId: WS, path: 'a/file/b', fileId: 'c' })
  })

  it("runs a route's middleware only for a file address", async () => {
    const app = appOver({ [DOC]: { path: 'doc' } })
    const ran: string[] = []
    onDocumentFile(
      app,
      'put',
      (c) => c.json({ hit: 'file' }),
      async (_c, next) => {
        ran.push('file middleware')
        await next()
      },
    )
    onDocumentAction(app, 'put', 'snapshot', (c) => c.json({ hit: 'snapshot' }))

    const read = await app.request(url(DOC, '/snapshot'), { method: 'PUT' })
    expect(await read.json()).toEqual({ hit: 'snapshot' })
    expect(ran).toEqual([])
  })
})

describe('onDocumentRoute', () => {
  it('captures the suffix params beside the placement', async () => {
    const app = appOver({ [DOC]: { path: 'notes/plan' } })
    onDocumentRoute(app, 'get', '/versions/:id/document', (c, _ws, path, params) =>
      c.json({ path, id: params.id }),
    )
    const res = await app.request(url(DOC, '/versions/v7/document'))
    expect(await res.json()).toEqual({ path: 'notes/plan', id: 'v7' })
  })

  it('takes the bare document address for the empty suffix', async () => {
    const app = appOver({ [DOC]: { path: 'notes/plan' } })
    onDocumentRoute(app, 'delete', '', (c, _ws, path) => c.json({ deleted: path }))
    const res = await app.request(url(DOC), { method: 'DELETE' })
    expect(await res.json()).toEqual({ deleted: 'notes/plan' })
  })

  it('refuses to serve an id route mounted without the address resolver', async () => {
    const app = new Hono()
    onDocumentRoute(app, 'get', '/snapshot', (c) => c.json({ hit: true }))
    app.onError((err, c) => c.json({ message: err.message }, 500))
    const res = await app.request(url(DOC, '/snapshot'))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({
      message: 'document id route mounted without resolveDocumentAddress',
    })
  })
})
