/**
 * The URL names the workspace and the document a `/api/v1` write is about;
 * the body may not. The tool inputs these routes parse with carry
 * `workspaceId` and `documentId` because a tool has no URL, and composing
 * them with the body spread LAST let a body's own `workspaceId` win over the
 * URL's — past a membership gate that had judged the URL's workspace. A
 * member of A who knew B's id could create documents in B, and rewrite B's
 * through linkify-mentions.
 */
import { describe, expect, it } from 'vitest'
import { createServer } from './create-server.js'
import { createInMemoryDocumentStore } from './test-utils/in-memory-document-store.js'
import { makeTestDeps } from './test-utils/make-test-deps.js'
import { inMemoryDocumentTeardown } from './test-utils/unused-document-teardown.js'

async function twoWorkspaces() {
  const deps = makeTestDeps({
    documentStore: createInMemoryDocumentStore(),
    documentTeardown: inMemoryDocumentTeardown(),
  })
  const { app } = createServer(deps)
  const post = (workspace: string, body: unknown, suffix = 'documents') =>
    app.request(`/api/v1/workspaces/${workspace}/${suffix}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  const listed = async (workspace: string) => {
    const res = await app.request(`/api/v1/workspaces/${workspace}/documents`)
    const { documents } = (await res.json()) as { documents: { path: string }[] }
    return documents.map((d) => d.path).sort()
  }
  await post('wsa', { path: 'a1', kind: 'spatial', createWorkspace: true })
  const createdB = (await (
    await post('wsb', { path: 'b1', kind: 'markdown', createWorkspace: true })
  ).json()) as { workspaceId: string; documentId: string }
  return { deps, post, listed, b: createdB }
}

describe('/api/v1 writes take their workspace and document from the URL alone', () => {
  it('refuses a create whose body names another workspace, and writes nothing there', async () => {
    const { post, listed, b } = await twoWorkspaces()
    const res = await post('wsa', { path: 'smuggled', kind: 'spatial', workspaceId: b.workspaceId })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'invalid_request' })
    expect(await listed('wsb')).toEqual(['b1'])
    expect(await listed('wsa')).toEqual(['a1'])
  })

  it('refuses a linkify whose body names another workspace or document', async () => {
    const { post, b } = await twoWorkspaces()
    const forWorkspace = await post(
      'wsa',
      { workspaceId: b.workspaceId },
      `documents/${b.documentId}/linkify-mentions`,
    )
    expect(forWorkspace.status).toBe(400)
    expect(await forWorkspace.json()).toMatchObject({ error: 'invalid_request' })
    const forDocument = await post(
      'wsb',
      { documentId: b.documentId },
      `documents/${b.documentId}/linkify-mentions`,
    )
    expect(forDocument.status).toBe(400)
    expect(await forDocument.json()).toMatchObject({ error: 'invalid_request' })
  })

  it('still creates from a body that names no identity', async () => {
    const { post, listed } = await twoWorkspaces()
    const res = await post('wsa', { path: 'a2', kind: 'spatial' })
    expect(res.status).toBe(201)
    expect(await listed('wsa')).toEqual(['a1', 'a2'])
  })
})
