/**
 * `PUT /api/v1/workspaces/:workspaceId/tag-library` writes the workspace's
 * declared tag vocabulary into the document at `tags`, creating that document
 * when the workspace has none — the daemon keeper's twin of the browser's
 * library writer, so a tag chip can colour a tag on either keeper.
 */

import { InMemoryDocumentStore } from '@kamiazya/whiteboard-ports/test-utils'
import { describe, expect, it } from 'vitest'
import { createServer } from './create-server.js'
import { makeTestDeps } from './test-utils/make-test-deps.js'
import { inMemoryDocumentTeardown } from './test-utils/unused-document-teardown.js'

async function workspace() {
  const deps = makeTestDeps({
    documentStore: new InMemoryDocumentStore(),
    documentTeardown: inMemoryDocumentTeardown(),
  })
  const { app } = createServer(deps)
  await app.request('/api/v1/workspaces/wsa/documents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'note', kind: 'markdown', createWorkspace: true }),
  })
  const put = (body: unknown) =>
    app.request('/api/v1/workspaces/wsa/tag-library', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  const read = async () => {
    const res = await app.request('/api/v1/workspaces/wsa/document-tags')
    return (await res.json()) as { library: Record<string, unknown> }
  }
  const paths = async () => {
    const res = await app.request('/api/v1/workspaces/wsa/documents')
    const { documents } = (await res.json()) as { documents: { path: string }[] }
    return documents.map((d) => d.path).sort()
  }
  return { put, read, paths }
}

const health = { health: { values: { ok: { color: '4' } } } }

describe('PUT /api/v1/workspaces/:workspaceId/tag-library', () => {
  it('creates the library document and reads back what was declared', async () => {
    const { put, read, paths } = await workspace()
    const res = await put({ library: health })
    expect(res.status).toBe(200)
    expect(await paths()).toEqual(['note', 'tags'])
    expect((await read()).library).toEqual(health)
  })

  it('replaces the declaration on a second write without a second document', async () => {
    const { put, read, paths } = await workspace()
    await put({ library: health })
    const next = { owner: { description: 'The team on call' } }
    expect((await put({ library: next })).status).toBe(200)
    expect(await paths()).toEqual(['note', 'tags'])
    expect((await read()).library).toEqual(next)
  })

  it('refuses a library the schema forbids and writes nothing', async () => {
    const { put, read, paths } = await workspace()
    const res = await put({ library: { Health: {} } })
    expect(res.status).toBe(400)
    expect(await paths()).toEqual(['note'])
    expect((await read()).library).toEqual({})
  })

  it('refuses a body that names another workspace', async () => {
    const { put } = await workspace()
    const res = await put({ library: health, workspaceId: 'wsb' })
    expect(res.status).toBe(400)
  })
})
