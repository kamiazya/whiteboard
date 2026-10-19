/**
 * Every address surface this package serves resolves its workspace handle the
 * same way — through the port's `resolveWorkspace`, once, at the boundary.
 *
 * These are behavioural tests against `createServer`'s own outputs rather than
 * against the wrapper in isolation: a helper that resolves correctly but is
 * not APPLIED reads identically to one that is, and the applying is the part
 * that has to hold across fourteen tools and every route.
 */
import { InMemoryDocumentIndex, InMemoryDocumentStore } from '@kamiazya/whiteboard-ports/test-utils'
import { Hono, type HonoRequest } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { beforeEach, describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { createServer } from './create-server.js'
import { makeTestDeps } from './test-utils/make-test-deps.js'
import { inMemoryDocumentTeardown } from './test-utils/unused-document-teardown.js'

const CANONICAL = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

function makeServer(index: InMemoryDocumentIndex) {
  return createServer(
    makeTestDeps({
      documentStore: new InMemoryDocumentStore(),
      documentIndex: index,
      documentTeardown: inMemoryDocumentTeardown(),
    }),
  )
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

// ADR-0053: a workspace address is its canonical id, `<handle>/<segment>`, or
// a bare segment in the CALLER's namespace — which is the composition root's
// to say, since only it knows who is calling.
describe('workspace addresses in the caller’s namespace', () => {
  const ALICES = '01ARZ3NDEKTSV4RRFFQ69G5FAW'
  const MEMBERLESS = '01ARZ3NDEKTSV4RRFFQ69G5FAX'
  let index: InMemoryDocumentIndex

  function serverFor(namespace: string) {
    return createServer(
      makeTestDeps({
        documentStore: new InMemoryDocumentStore(),
        documentIndex: index,
        documentTeardown: inMemoryDocumentTeardown(),
        callerNamespace: async () => namespace,
      }),
    )
  }

  const pathsIn = async (server: ReturnType<typeof serverFor>, workspaceId: string) =>
    (await server.tools.documentList.execute({ workspaceId })).documents.map((d) => d.path)

  beforeEach(async () => {
    index = new InMemoryDocumentIndex()
    // The same segment in two namespaces: which one answers is the question.
    await index.createWorkspace({ workspaceId: ALICES, namespace: 'alice', segment: 'design' })
    await index.createWorkspace({ workspaceId: MEMBERLESS, segment: 'design' })
    await index.createDocument({ workspaceId: ALICES, path: 'alices', kind: 'markdown' })
    await index.createDocument({ workspaceId: MEMBERLESS, path: 'memberless', kind: 'markdown' })
  })

  it('resolves a bare segment in the namespace the deps name, for a tool', async () => {
    expect(await pathsIn(serverFor('alice'), 'design')).toEqual(['alices'])
    expect(await pathsIn(serverFor('me'), 'design')).toEqual(['memberless'])
  })

  it('resolves a bare segment in the namespace the deps name, over /api/v1', async () => {
    const res = await serverFor('alice').app.request('/api/v1/workspaces/design/documents')
    expect(res.status).toBe(200)
    expect(JSON.stringify(await res.json())).toContain('alices')
  })

  // The seam is handed the HonoRequest, which `hono/body-limit` keeps while
  // it swaps `c.req.raw` for a body of unstated length — so a namespace a
  // keeper recorded before that swap is still the one /api/v1 resolves in.
  it('resolves in the recorded namespace behind a body limit, for a body of unstated length', async () => {
    const recorded = new WeakMap<HonoRequest, string>()
    const server = createServer(
      makeTestDeps({
        documentStore: new InMemoryDocumentStore(),
        documentIndex: index,
        documentTeardown: inMemoryDocumentTeardown(),
        callerNamespace: async (request) =>
          (request === undefined ? undefined : recorded.get(request)) ?? 'me',
      }),
    )
    const app = new Hono()
    app.use('*', async (c, next) => {
      recorded.set(c.req, 'alice')
      await next()
    })
    app.use('*', bodyLimit({ maxSize: 64 * 1024 }))
    app.route('/', server.app)
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(JSON.stringify({ path: 'behind-limit', kind: 'markdown' })),
        )
        controller.close()
      },
    })
    const res = await app.request('/api/v1/workspaces/design/documents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      duplex: 'half',
    } as RequestInit)
    expect(res.status).toBe(201)
    expect(await pathsIn(serverFor('alice'), ALICES)).toContain('behind-limit')
  })

  it('reaches a qualified handle in any namespace, whoever is calling', async () => {
    expect(await pathsIn(serverFor('alice'), 'me/design')).toEqual(['memberless'])
    expect(await pathsIn(serverFor('me'), 'alice/design')).toEqual(['alices'])
  })

  it('admits all three forms in every tool’s workspaceId', () => {
    const { tools } = serverFor('alice')
    const scoped = Object.values(tools).filter(
      (tool) =>
        tool.name !== 'wb_facet_list' &&
        'workspaceId' in (tool.inputSchema as { shape: object }).shape,
    )
    // Every workspace-scoped tool but the facet catalogue, whose workspace is optional.
    expect(scoped.length).toBeGreaterThan(14)
    for (const tool of scoped) {
      const field = (tool.inputSchema as unknown as { shape: Record<string, z.ZodType> }).shape
        .workspaceId as z.ZodType
      for (const address of [ALICES, 'alice/design', 'design']) {
        expect(field.safeParse(address).success, `${tool.name} ${address}`).toBe(true)
      }
      expect(field.safeParse('a/b/c').success, tool.name).toBe(false)
      expect(field.description, tool.name).toMatch(/<handle>\/<segment>/)
    }
  })

  const createNotes = (workspaceId: string) => ({
    workspaceId,
    createWorkspace: true,
    ops: [{ op: 'document.create' as const, path: 'notes', kind: 'markdown' as const }],
  })

  it('mints a qualified handle in the caller’s own namespace under its segment', async () => {
    const { tools } = serverFor('alice')
    const created = await tools.workspaceEdit.execute(createNotes('alice/fresh'))
    const entry = (await index.listWorkspaces()).find((w) => w.workspaceId === created.workspaceId)
    expect(entry).toMatchObject({ namespace: 'alice', segment: 'fresh' })
  })

  it('never mints a qualified handle in another namespace', async () => {
    const { tools } = serverFor('alice')
    const before = await index.listWorkspaces()
    await expect(tools.workspaceEdit.execute(createNotes('bob/fresh'))).rejects.toThrow(
      /Workspace not found: "bob\/fresh"/,
    )
    expect(await index.listWorkspaces()).toEqual(before)
  })
})
