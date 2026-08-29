/**
 * Every address surface this package serves resolves its workspace handle the
 * same way — through the port's `resolveWorkspace`, once, at the boundary.
 *
 * These are behavioural tests against `createServer`'s own outputs rather than
 * against the wrapper in isolation: a helper that resolves correctly but is
 * not APPLIED reads identically to one that is, and the applying is the part
 * that has to hold across fourteen tools and every route.
 */
import { InMemoryDocumentIndex } from '@kamiazya/whiteboard-ports/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'
import { createServer } from './create-server.js'
import { ignoredDocumentWrites } from './test-utils/ignored-document-writes.js'
import { createInMemoryDocumentStore } from './test-utils/in-memory-document-store.js'
import { inMemoryDocumentTeardown } from './test-utils/unused-document-teardown.js'

const CANONICAL = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

function makeServer(index: InMemoryDocumentIndex) {
  return createServer({
    documentStore: createInMemoryDocumentStore(),
    blobStore: {} as never,
    documentIndex: index,
    documentTeardown: inMemoryDocumentTeardown(),
    documentWritten: ignoredDocumentWrites(),
  })
}

describe('workspace handles at the server boundary', () => {
  let index: InMemoryDocumentIndex

  beforeEach(async () => {
    index = new InMemoryDocumentIndex()
    await index.createWorkspace({ workspaceId: CANONICAL, segment: 'design' })
    // Asserted, not assumed: every case below is about a segment resolving,
    // and a registry that dropped it would make them all pass by falling
    // through to the id branch.
    expect((await index.listWorkspaces())[0]?.segment).toBe('design')
    await index.createDocument({ workspaceId: CANONICAL, path: 'notes/spec', kind: 'markdown' })
  })

  it('lists by segment exactly as by canonical id, over HTTP', async () => {
    const { app } = makeServer(index)
    const bySegment = await app.request(`/api/v1/workspaces/design/documents`)
    const byId = await app.request(`/api/v1/workspaces/${CANONICAL}/documents`)
    expect(bySegment.status).toBe(200)
    expect(await bySegment.json()).toEqual(await byId.json())
  })

  it('lists by segment through the MCP tool the daemon actually registers', async () => {
    // Through `createServer(deps).tools`, not the tool factory directly: the
    // wrapper is what is under test, and calling the factory would bypass it.
    const { tools } = makeServer(index)
    const bySegment = await tools.documentSearch.execute({ workspaceId: 'design', query: 'spec' })
    const byId = await tools.documentSearch.execute({ workspaceId: CANONICAL, query: 'spec' })
    expect(bySegment).toEqual(byId)
  })

  it('keeps an unresolvable handle failing exactly as before', async () => {
    // Fallback-total: a handle that names nothing passes through unchanged, so
    // the 404 comes from the same lookup and carries the same text it always
    // did. No new error vocabulary is introduced by resolution.
    const { app } = makeServer(index)
    const res = await app.request('/api/v1/workspaces/no-such-workspace/documents')
    expect(res.status).toBe(404)
  })

  it('is the identity over a segmentless registry — the Stage-1 no-op', async () => {
    const plain = new InMemoryDocumentIndex()
    await plain.createWorkspace({ workspaceId: 'default' })
    await plain.createDocument({ workspaceId: 'default', path: 'a', kind: 'markdown' })
    const { app } = makeServer(plain)
    const res = await app.request('/api/v1/workspaces/default/documents')
    expect(res.status).toBe(200)
  })
})
