import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  deleteDocumentResponseSchema,
  listWorkspacesResponseSchema,
  renameDocumentPathResponseSchema,
  workspaceSummarySchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/document'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { Hono } from 'hono'
import { LoroDoc, LoroMap } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTestDocument,
  resolveTestServerDeps,
  seedWorkspaceRow,
  withTempDataDir,
} from '../_test-helpers.js'

const tmp = withTempDataDir('whiteboard-workspaces-test-')

// The deps a router is handed by its root; here, the test wiring over the
// temp data dir (routers no longer compose their own).
let serverDeps: ServerDeps
beforeEach(async () => {
  serverDeps = await resolveTestServerDeps(tmp.dir)
})

vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

// Mock the store so `getDoc` can be gated to control interleaving against a
// concurrent rename/delete. It must be THIS module: `getDoc` is the store's
// cached read, and doc-cache.js (which holds the LRU it reads through) never
// exports it. Mocking the wrong module is silent — a factory spreading
// `...actual` just adds a property nobody imports, and the race never stages.
vi.mock('../../store/document-store.js', async () => {
  const actual = await vi.importActual<typeof import('../../store/document-store.js')>(
    '../../store/document-store.js',
  )
  return { ...actual, getDoc: vi.fn(actual.getDoc) }
})

const { clearCache, peekDoc } = await import('../../store/doc-cache.js')

const { getDoc } = await import('../../store/document-store.js')
const documentStore = await import('../../store/document-store.js')
const { saveDocument } = documentStore
const { corruptStoredData } = await import('../../store/corrupt-stored-data.js')
const { createWorkspacesRouter } = await import('./workspaces.js')
const { createDocumentRouter } = await import('../document.js')
const { getDb } = await import('../../store/db/index.js')
const { createContainer, resolveServerDeps } = await import('../../../di/container.js')
const { createSelfHostStoreLocalModule } = await import('../../../di/store-local.module.js')

// These routes are adapters over the document index (ADR-0018), so forcing
// one to fail means making the OPERATION fail, not stubbing a store function
// the route no longer calls. `Object.create` rather than a spread: the index
// is a class instance, and spreading one drops every method it inherits from
// its prototype.
async function depsWithFailing(method: 'deleteDocument' | 'moveDocument', err: unknown) {
  const db = await getDb(tmp.dir)
  const deps = resolveServerDeps(createContainer(createSelfHostStoreLocalModule(db, tmp.dir)))
  // A Proxy that binds every untouched method to the REAL instance:
  // Object.create is not enough for the tree index, whose private fields
  // reject a detached receiver ("Receiver must be an instance of class").
  const inner = deps.documentIndex
  const index = new Proxy(inner, {
    get(target, key) {
      if (key === method) return () => Promise.reject(err)
      const value = Reflect.get(target, key, target)
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value
    },
  }) as typeof deps.documentIndex
  return { ...deps, documentIndex: index }
}

beforeEach(() => {
  clearCache()
})
afterEach(() => {
  clearCache()
})

describe('workspaces router', () => {
  it('returns a Hono instance', () => {
    const app = createWorkspacesRouter({ serverDeps })
    expect(app).toBeInstanceOf(Hono)
  })
})

describe('GET /api/workspaces', () => {
  it('returns the canonical workspace list with workspaceId entries', async () => {
    await saveDocument('workspace-a', 'a', new LoroDoc())
    const app = createDocumentRouter({ serverDeps })
    const res = await app.request('/api/workspaces')

    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      workspaces: Array<{ workspaceId: string; documentCount?: number }>
    }
    // `documentCount` joined the row when the switcher started showing it.
    // This case pins WHICH workspaces are listed, so it carries the field
    // rather than asserting a shape the route no longer has.
    expect(json.workspaces).toEqual([{ workspaceId: 'workspace-a', documentCount: 1 }])
  })

  // ADR-0019: segment/displayName flow from the registry row through this
  // route, and a workspace with neither omits the keys rather than serving
  // null/undefined — the same "absent, not invented" contract the port uses.
  it('serves segment/displayName for a workspace that has them, and omits the keys for one that does not', async () => {
    const db = await getDb(tmp.dir)
    const deps = resolveServerDeps(createContainer(createSelfHostStoreLocalModule(db, tmp.dir)))
    await deps.documentIndex.createWorkspace({
      workspaceId: 'workspace-named',
      segment: 'team-notes',
      displayName: 'Team notes',
    })
    await deps.documentIndex.createWorkspace({ workspaceId: 'workspace-bare' })

    const app = createDocumentRouter({ serverDeps })
    const res = await app.request('/api/workspaces')
    expect(res.status).toBe(200)
    const json = await res.json()
    const parsed = listWorkspacesResponseSchema.parse(json)

    const named = parsed.workspaces.find((w) => w.workspaceId === 'workspace-named')
    expect(named).toEqual({
      workspaceId: 'workspace-named',
      segment: 'team-notes',
      displayName: 'Team notes',
      documentCount: 0,
    })
    const bare = parsed.workspaces.find((w) => w.workspaceId === 'workspace-bare')
    // Zero, and PRESENT: an empty workspace is counted, not left uncounted.
    // Which is the distinction the two assertions below are about — those
    // layers are absent because nobody chose them, and this test's subject is
    // that absence, not the row's total width.
    expect(bare).toEqual({ workspaceId: 'workspace-bare', documentCount: 0 })
    expect('segment' in (bare ?? {})).toBe(false)
    expect('displayName' in (bare ?? {})).toBe(false)
  })

  // ADR-0042 decisions 1/3/5: app.ts only wires `replicaTier` when a
  // replica-key store was supplied, so a caller without one keeps parsing
  // under listWorkspacesResponseSchema exactly as before this field existed.
  it('echoes tier per row when a resolver is threaded, and omits it otherwise', async () => {
    const db = await getDb(tmp.dir)
    const deps = resolveServerDeps(createContainer(createSelfHostStoreLocalModule(db, tmp.dir)))
    await deps.documentIndex.createWorkspace({ workspaceId: 'workspace-tiered' })

    const withResolver = createWorkspacesRouter({
      serverDeps: deps,
      replicaTier: async () => 'bounded',
    })
    const withRes = await withResolver.request('/api/workspaces')
    const withParsed = listWorkspacesResponseSchema.parse(await withRes.json())
    expect(withParsed.workspaces.find((w) => w.workspaceId === 'workspace-tiered')?.tier).toBe(
      'bounded',
    )

    const withoutResolver = createWorkspacesRouter({ serverDeps: deps })
    const withoutRes = await withoutResolver.request('/api/workspaces')
    const withoutParsed = listWorkspacesResponseSchema.parse(await withoutRes.json())
    const row = withoutParsed.workspaces.find((w) => w.workspaceId === 'workspace-tiered')
    expect(row && 'tier' in row).toBe(false)
  })

  // SEQUENTIAL, and that is the load-bearing part (the route's own comment):
  // `Promise.all` over the rows opens N workspace records at once against
  // the one SQLite file, and on a real daemon holding real workspaces that
  // 500ed every row with SQLITE_BUSY. That contention cannot be reproduced
  // deterministically here — each test gets a fresh, idle database — so this
  // pins the DECISION instead of the symptom: the per-row document listings
  // never overlap. Reverting the loop to `Promise.all` drives the observed
  // peak concurrency to the row count and fails the last assertion.
  it('counts each workspace sequentially — the per-row listings never overlap', async () => {
    const db = await getDb(tmp.dir)
    const deps = resolveServerDeps(createContainer(createSelfHostStoreLocalModule(db, tmp.dir)))
    for (const workspaceId of ['workspace-a', 'workspace-b', 'workspace-c']) {
      await deps.documentIndex.createWorkspace({ workspaceId })
    }
    let inFlight = 0
    let peak = 0
    const inner = deps.documentIndex
    const index = new Proxy(inner, {
      get(target, key) {
        if (key === 'listDocuments') {
          return async (...args: unknown[]) => {
            inFlight += 1
            peak = Math.max(peak, inFlight)
            // Long enough that a Promise.all shape reliably overlaps all
            // three rows before the first listing resolves.
            await new Promise((resolve) => setTimeout(resolve, 5))
            try {
              return await (inner.listDocuments as (...a: unknown[]) => Promise<unknown>).apply(
                target,
                args,
              )
            } finally {
              inFlight -= 1
            }
          }
        }
        const value = Reflect.get(target, key, target)
        return typeof value === 'function'
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value
      },
    }) as typeof deps.documentIndex

    const app = createWorkspacesRouter({ serverDeps: { ...deps, documentIndex: index } })
    const res = await app.request('/api/workspaces')
    expect(res.status).toBe(200)
    const parsed = listWorkspacesResponseSchema.parse(await res.json())
    expect(parsed.workspaces).toHaveLength(3)
    expect(
      peak,
      'GET /api/workspaces overlapped its per-row document listings — the Promise.all shape that 500ed a real daemon with SQLITE_BUSY',
    ).toBe(1)
  })
})

// Documents are created through `/api/v1` (server-core's route over
// `wbDocumentCreate`), which every client has used since the web app moved
// there. This router keeping a second way in meant two creation surfaces with
// their own validation and error wording over one operation.
describe('POST /api/workspaces/:workspaceId/documents', () => {
  it('is not a route any more: creation goes through /api/v1', async () => {
    const app = createDocumentRouter({ serverDeps })
    const res = await app.request('/api/workspaces/ws1/documents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'new-canvas' }),
    })
    expect(res.status).toBe(404)
  })
})

describe('DELETE /api/workspaces/:workspaceId/documents/:path', () => {
  beforeEach(async () => {
    await mkdir(join(tmp.dir, 'session1'), { recursive: true })
  })

  it('returns 200 { ok: true }, parses with deleteDocumentResponseSchema, and the canvas is gone from list/exists/snapshot', async () => {
    await saveDocument('session1', 'canvas-a', new LoroDoc())
    const app = createDocumentRouter({ serverDeps })

    const res = await app.request('/api/workspaces/session1/documents/canvas-a', {
      method: 'DELETE',
    })
    expect(res.status).toBe(200)
    const json: unknown = await res.json()
    expect(deleteDocumentResponseSchema.parse(json)).toEqual({ ok: true })

    const listRes = await app.request('/api/workspaces/session1/documents')
    const listJson = (await listRes.json()) as { documents: { path: string }[] }
    expect(listJson.documents.map((c) => c.path)).not.toContain('canvas-a')

    const existsRes = await app.request('/api/w/session1/document/canvas-a/exists')
    expect(await existsRes.json()).toEqual({ exists: false })

    const snapshotRes = await app.request('/api/w/session1/document/canvas-a/snapshot')
    expect(snapshotRes.status).toBe(404)
  })

  // A refusal the caller can act on, not a server failure: 409 with the
  // offending descendant named, so the UI can say which one to deal with.
  it('returns 409 naming a descendant rather than stranding it', async () => {
    await saveDocument('session1', 'design', new LoroDoc())
    await saveDocument('session1', 'design/login', new LoroDoc())
    const app = createDocumentRouter({ serverDeps })

    const res = await app.request('/api/workspaces/session1/documents/design', {
      method: 'DELETE',
    })

    expect(res.status).toBe(409)
    const json = (await res.json()) as { title?: string }
    expect(json.title).toContain('design/login')
  })

  it('returns 404 with Problem Details { title } for a missing canvas', async () => {
    const app = createDocumentRouter({ serverDeps })
    const res = await app.request('/api/workspaces/session1/documents/never-created', {
      method: 'DELETE',
    })
    expect(res.status).toBe(404)
    const json = (await res.json()) as { title?: string }
    expect(typeof json.title).toBe('string')
    expect(json.title!.length).toBeGreaterThan(0)
    expect(json).not.toHaveProperty('error')
  })

  it('returns 400 with Problem Details { title } for an invalid workspaceId or path', async () => {
    const app = createDocumentRouter({ serverDeps })

    const badWs = await app.request('/api/workspaces/bad.workspace/documents/canvas-a', {
      method: 'DELETE',
    })
    expect(badWs.status).toBe(400)
    expect(typeof ((await badWs.json()) as { title?: string }).title).toBe('string')

    const badPath = await app.request('/api/workspaces/session1/documents/bad.path', {
      method: 'DELETE',
    })
    expect(badPath.status).toBe(400)
    expect(typeof ((await badPath.json()) as { title?: string }).title).toBe('string')
  })

  it('maps a thrown CorruptStoredDataError to 500 { error: corrupt_stored_data }, and only that error type — a plain throw stays a generic 500', async () => {
    await saveDocument('session1', 'canvas-a', new LoroDoc())
    const corrupt = createDocumentRouter({
      serverDeps: await depsWithFailing(
        'deleteDocument',
        corruptStoredData('/tmp/blobs/session1/document/abc.loro', 'broken canvas blob'),
      ),
    })
    const res = await corrupt.request('/api/workspaces/session1/documents/canvas-a', {
      method: 'DELETE',
    })
    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({
      error: 'corrupt_stored_data',
      message: expect.stringContaining('broken canvas blob'),
    })

    // Mutation guard: a non-corruption throw must NOT hit the same branch —
    // proves the mapping checks the error type, not "any throw".
    const plain = createDocumentRouter({
      serverDeps: await depsWithFailing('deleteDocument', new Error('disk exploded')),
    })
    const res2 = await plain.request('/api/workspaces/session1/documents/canvas-a', {
      method: 'DELETE',
    })
    expect(res2.status).toBe(500)
    const json2: unknown = await res2.json()
    expect(json2).not.toMatchObject({ error: 'corrupt_stored_data' })
  })

  it('evicts the doc-cache on delete, so re-creating the same path after a warm cache read yields a fresh empty doc', async () => {
    // Registered up front so the POST below is not the thing that creates it:
    // that route passes `createWorkspace: true`, which is ADR-0019's mint
    // boundary, and a mint would key the workspace by a ULID and file
    // `session1` as its segment — leaving the store reads further down
    // naming nothing.
    await seedWorkspaceRow(tmp.dir, 'session1')
    const app = createDocumentRouter({ serverDeps })
    await createTestDocument(serverDeps, { workspaceId: 'session1', path: 'cached' })
    const clientDoc = new LoroDoc()
    const prevVV = clientDoc.version()
    const list = clientDoc.getMovableList('elements')
    const m = list.insertContainer(0, new LoroMap())
    m.set('id', 'old-element')
    clientDoc.commit()
    const update = clientDoc.export({ mode: 'update', from: prevVV })
    // Warm the doc-cache via the update path, matching real client traffic.
    await app.request('/api/w/session1/document/cached/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: update,
    })
    expect(peekDoc('session1', 'cached')).toBeDefined()

    const delRes = await app.request('/api/workspaces/session1/documents/cached', {
      method: 'DELETE',
    })
    expect(delRes.status).toBe(200)

    // Re-creating must succeed (not 409) and must not resurrect the old doc.
    await createTestDocument(serverDeps, { workspaceId: 'session1', path: 'cached' })

    const snapshotRes = await app.request('/api/w/session1/document/cached/snapshot')
    expect(snapshotRes.status).toBe(200)
    const buf = await snapshotRes.arrayBuffer()
    const restored = LoroDoc.fromSnapshot(new Uint8Array(buf))
    expect(restored.getMovableList('elements').length).toBe(0)
  })
})

describe('PUT /api/workspaces/:workspaceId/documents/:path/path', () => {
  beforeEach(async () => {
    await mkdir(join(tmp.dir, 'session1'), { recursive: true })
  })

  // The store computes WHICH path actually collided; rebuilding the message
  // from the requested path names one that is free, which is worse than
  // saying nothing — the caller retries a rename that was never the problem.
  it('names the descendant that collided, not the free path the caller asked for', async () => {
    await saveDocument('session1', 'a', new LoroDoc())
    await saveDocument('session1', 'a/x', new LoroDoc())
    await saveDocument('session1', 'c/x', new LoroDoc())
    const app = createDocumentRouter({ serverDeps })

    const res = await app.request('/api/workspaces/session1/documents/a/path', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'c' }),
    })

    expect(res.status).toBe(409)
    const json = (await res.json()) as { title?: string }
    expect(json.title).toContain('c/x')
  })

  it('refuses a move into the document’s own subtree with 400, not a generic 500', async () => {
    await saveDocument('session1', 'a', new LoroDoc())
    await saveDocument('session1', 'a/x', new LoroDoc())
    const app = createDocumentRouter({ serverDeps })

    const res = await app.request('/api/workspaces/session1/documents/a/path', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'a/x' }),
    })

    expect(res.status).toBe(400)
  })

  it('returns 200 { path }, the list shows the new path and not the old one, the old snapshot URL 404s, and re-creating the old path afterward succeeds as a fresh canvas', async () => {
    await saveDocument('session1', 'a', new LoroDoc())
    const app = createDocumentRouter({ serverDeps })

    const res = await app.request('/api/workspaces/session1/documents/a/path', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'b' }),
    })
    expect(res.status).toBe(200)
    const json: unknown = await res.json()
    expect(renameDocumentPathResponseSchema.parse(json)).toEqual({ path: 'b' })

    const listRes = await app.request('/api/workspaces/session1/documents')
    const listJson = (await listRes.json()) as { documents: { path: string }[] }
    const paths = listJson.documents.map((c) => c.path)
    expect(paths).toContain('b')
    expect(paths).not.toContain('a')

    const oldSnapshotRes = await app.request('/api/w/session1/document/a/snapshot')
    expect(oldSnapshotRes.status).toBe(404)

    await createTestDocument(serverDeps, { workspaceId: 'session1', path: 'a' })
  })

  it('returns 404 with Problem Details { title } for a missing source canvas', async () => {
    const app = createDocumentRouter({ serverDeps })
    const res = await app.request('/api/workspaces/session1/documents/never-created/path', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'target' }),
    })
    expect(res.status).toBe(404)
    const json = (await res.json()) as { title?: string }
    expect(typeof json.title).toBe('string')
    expect(json.title!.length).toBeGreaterThan(0)
    expect(json).not.toHaveProperty('error')
  })

  it('returns 409 with Problem Details { title } when the target path is already taken', async () => {
    await saveDocument('session1', 'a', new LoroDoc())
    await saveDocument('session1', 'b', new LoroDoc())
    const app = createDocumentRouter({ serverDeps })
    const res = await app.request('/api/workspaces/session1/documents/a/path', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'b' }),
    })
    expect(res.status).toBe(409)
    const json = (await res.json()) as { title?: string }
    expect(typeof json.title).toBe('string')
    expect(json.title!.length).toBeGreaterThan(0)

    // Neither canvas was mutated by the rejected rename.
    const listRes = await app.request('/api/workspaces/session1/documents')
    const listJson = (await listRes.json()) as { documents: { path: string }[] }
    expect(listJson.documents.map((c) => c.path).sort()).toEqual(['a', 'b'])
  })

  it('does not fork a phantom duplicate canvas when a rename races an in-flight /update that already resolved a doc reference through the old path', async () => {
    const app = createDocumentRouter({ serverDeps })
    const baseDoc = new LoroDoc()
    baseDoc.getText('content').insert(0, 'original')
    baseDoc.commit()
    await saveDocument('session1', 'a', baseDoc)

    // A client update built against the pre-rename base.
    const clientDoc = LoroDoc.fromSnapshot(baseDoc.export({ mode: 'snapshot' }))
    const fromVV = clientDoc.version()
    clientDoc.getText('content').insert('original'.length, ' + edit')
    clientDoc.commit()
    const update = clientDoc.export({ mode: 'update', from: fromVV })

    // Stall the /update route's getDoc() call so a rename can be fired
    // while the request is paused mid-flight, matching the real race: the
    // read resolves before the rename runs, the write happens after.
    let releaseGetDoc: () => void = () => undefined
    const getDocGate = new Promise<void>((resolve) => {
      releaseGetDoc = resolve
    })
    let signalGetDocCalled: () => void = () => undefined
    const getDocCalled = new Promise<void>((resolve) => {
      signalGetDocCalled = resolve
    })
    const actual = await vi.importActual<typeof import('../../store/document-store.js')>(
      '../../store/document-store.js',
    )
    vi.mocked(getDoc).mockImplementationOnce(async (workspaceId, path) => {
      signalGetDocCalled()
      await getDocGate
      return actual.getDoc(workspaceId, path)
    })

    const updatePromise = app.request('/api/w/session1/document/a/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: update,
    })

    await getDocCalled

    // Fire the rename while the update is stalled mid-flight.
    const renamePromise = app.request('/api/workspaces/session1/documents/a/path', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'b' }),
    })
    // Give the rename a chance to run before letting the stalled read continue.
    await new Promise((r) => setTimeout(r, 20))
    releaseGetDoc()

    const [updateRes, renameRes] = await Promise.all([updatePromise, renamePromise])
    expect(renameRes.status).toBe(200)
    expect(updateRes.status).toBe(200)

    // Exactly one canvas must survive -- the update must not have silently
    // inserted a phantom duplicate back at the old path.
    const listRes = await app.request('/api/workspaces/session1/documents')
    const listJson = (await listRes.json()) as { documents: { path: string }[] }
    expect(listJson.documents.map((c) => c.path)).toEqual(['b'])
  })

  it('returns 400 with Problem Details { title } for invalid input shapes', async () => {
    await saveDocument('session1', 'a', new LoroDoc())
    const app = createDocumentRouter({ serverDeps })

    const noBody = await app.request('/api/workspaces/session1/documents/a/path', {
      method: 'PUT',
    })
    expect(noBody.status).toBe(400)

    const badNewPath = await app.request('/api/workspaces/session1/documents/a/path', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'bad.path' }),
    })
    expect(badNewPath.status).toBe(400)

    const emptyPath = await app.request('/api/workspaces/session1/documents/a/path', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '' }),
    })
    expect(emptyPath.status).toBe(400)

    const badWorkspace = await app.request('/api/workspaces/bad.workspace/documents/a/path', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'b' }),
    })
    expect(badWorkspace.status).toBe(400)

    const badCurrentPath = await app.request('/api/workspaces/session1/documents/bad.path/path', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'b' }),
    })
    expect(badCurrentPath.status).toBe(400)

    for (const res of [noBody, badNewPath, emptyPath, badWorkspace, badCurrentPath]) {
      const body = (await res.json()) as { title?: string }
      expect(typeof body.title).toBe('string')
      expect(body.title!.length).toBeGreaterThan(0)
    }
  })

  it('evicts the doc-cache on rename: updating via the OLD path afterward lazily creates a FRESH canvas rather than resurrecting the warmed doc, while the new path keeps the real content', async () => {
    // Registered up front so the POST below is not the thing that creates it:
    // that route passes `createWorkspace: true`, which is ADR-0019's mint
    // boundary, and a mint would key the workspace by a ULID and file
    // `session1` as its segment — leaving the store reads further down
    // naming nothing.
    await seedWorkspaceRow(tmp.dir, 'session1')
    const app = createDocumentRouter({ serverDeps })
    await createTestDocument(serverDeps, { workspaceId: 'session1', path: 'a' })
    const clientDoc = new LoroDoc()
    const prevVV = clientDoc.version()
    const list = clientDoc.getMovableList('elements')
    const m = list.insertContainer(0, new LoroMap())
    m.set('id', 'old-element')
    clientDoc.commit()
    const update = clientDoc.export({ mode: 'update', from: prevVV })
    // Warm the doc-cache via the update path, matching real client traffic.
    await app.request('/api/w/session1/document/a/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: update,
    })
    expect(peekDoc('session1', 'a')).toBeDefined()

    const renameRes = await app.request('/api/workspaces/session1/documents/a/path', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'b' }),
    })
    expect(renameRes.status).toBe(200)

    // The renamed canvas keeps its content, now reachable at the new path.
    const bSnapshotRes = await app.request('/api/w/session1/document/b/snapshot')
    expect(bSnapshotRes.status).toBe(200)
    const bBuf = await bSnapshotRes.arrayBuffer()
    const bRestored = LoroDoc.fromSnapshot(new Uint8Array(bBuf))
    expect(
      (bRestored.getMovableList('elements').toJSON() as { id: string }[]).map((e) => e.id),
    ).toEqual(['old-element'])

    // Updating through the OLD path lazily creates a FRESH canvas — it must
    // not resurrect the evicted doc's history.
    const anotherClientDoc = new LoroDoc()
    const anotherPrevVV = anotherClientDoc.version()
    const anotherList = anotherClientDoc.getMovableList('elements')
    const anotherM = anotherList.insertContainer(0, new LoroMap())
    anotherM.set('id', 'fresh-element')
    anotherClientDoc.commit()
    const anotherUpdate = anotherClientDoc.export({ mode: 'update', from: anotherPrevVV })
    await app.request('/api/w/session1/document/a/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: anotherUpdate,
    })

    const freshSnapshotRes = await app.request('/api/w/session1/document/a/snapshot')
    expect(freshSnapshotRes.status).toBe(200)
    const freshBuf = await freshSnapshotRes.arrayBuffer()
    const freshRestored = LoroDoc.fromSnapshot(new Uint8Array(freshBuf))
    const freshIds = (freshRestored.getMovableList('elements').toJSON() as { id: string }[]).map(
      (e) => e.id,
    )
    expect(freshIds).toEqual(['fresh-element'])
    expect(freshIds).not.toContain('old-element')
  })

  it('maps a thrown CorruptStoredDataError to 500 { error: corrupt_stored_data }, and only that error type — a plain throw stays a generic 500', async () => {
    await saveDocument('session1', 'a', new LoroDoc())
    const body = JSON.stringify({ path: 'b' })
    const headers = { 'Content-Type': 'application/json' }
    const corrupt = createDocumentRouter({
      serverDeps: await depsWithFailing(
        'moveDocument',
        corruptStoredData('/tmp/blobs/session1/document/abc.loro', 'broken canvas blob'),
      ),
    })
    const res = await corrupt.request('/api/workspaces/session1/documents/a/path', {
      method: 'PUT',
      headers,
      body,
    })
    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({
      error: 'corrupt_stored_data',
      message: expect.stringContaining('broken canvas blob'),
    })

    // Mutation guard: a non-corruption throw must NOT hit the same branch —
    // proves the mapping checks the error type, not "any throw".
    const plain = createDocumentRouter({
      serverDeps: await depsWithFailing('moveDocument', new Error('disk exploded')),
    })
    const res2 = await plain.request('/api/workspaces/session1/documents/a/path', {
      method: 'PUT',
      headers,
      body,
    })
    expect(res2.status).toBe(500)
    const json2: unknown = await res2.json()
    expect(json2).not.toMatchObject({ error: 'corrupt_stored_data' })
  })
})

describe('GET /api/workspaces/:workspaceId/documents', () => {
  beforeEach(async () => {
    await mkdir(join(tmp.dir, 'session1'), { recursive: true })
  })

  it('returns the canvas list', async () => {
    await saveDocument('session1', 'canvas-a', new LoroDoc())
    await saveDocument('session1', 'canvas-b', new LoroDoc())

    const app = createDocumentRouter({ serverDeps })
    const res = await app.request('/api/workspaces/session1/documents')
    expect(res.status).toBe(200)
    const json = (await res.json()) as { documents: { path: string }[] }
    const paths = json.documents.map((c) => c.path)
    expect(paths).toContain('canvas-a')
    expect(paths).toContain('canvas-b')
  })

  it('returns 400 for an invalid workspaceId', async () => {
    const app = createDocumentRouter({ serverDeps })
    const res = await app.request('/api/workspaces/bad.sid/documents')
    expect(res.status).toBe(400)
  })

  it('returns 404 for a workspace that does not exist, not an empty list', async () => {
    // A 200-empty here is a false statement of fact: the caller cannot tell
    // "this workspace has no documents" from "you asked about a workspace this
    // daemon has never heard of", and the web app renders the first reading —
    // an empty state with a Create button — for what is actually the second.
    // A stale pairing (a workspace id minted by an earlier install and kept
    // in the browser's localStorage) then looks exactly like data loss.
    // The v1 document routes already 404 an unknown workspace; this brings
    // the legacy list route into agreement.
    const app = createDocumentRouter({ serverDeps })
    const res = await app.request('/api/workspaces/never-registered/documents')
    expect(res.status).toBe(404)
  })

  // listDocuments no longer walks per-workspace directories, so the previous
  // "broken session directory" 500 case no longer applies.
})

describe('GET /api/workspaces/:workspaceId/documents', () => {
  beforeEach(async () => {
    await mkdir(join(tmp.dir, 'workspace1'), { recursive: true })
  })

  it('also returns the canvas list from the canonical workspace route', async () => {
    await saveDocument('workspace1', 'canvas-a', new LoroDoc())

    const app = createDocumentRouter({ serverDeps })
    const res = await app.request('/api/workspaces/workspace1/documents')

    expect(res.status).toBe(200)
    const json = (await res.json()) as { documents: { path: string }[] }
    expect(json.documents).toEqual([expect.objectContaining({ path: 'canvas-a' })])
  })
})

// The write half of the workspace resource. Until this, the daemon published
// `GET /api/workspaces` and nothing that changes one, so the shell's switcher
// offered neither creation nor renaming there — the keeper could not honour
// them, so it did not promise them.
describe('POST /api/workspaces', () => {
  async function create(app: ReturnType<typeof createWorkspacesRouter>, body: unknown) {
    return app.request('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('mints the canonical id and derives the address from the name it was given', async () => {
    const app = createWorkspacesRouter({ serverDeps })
    const res = await create(app, { displayName: 'Marketing Team' })

    expect(res.status).toBe(201)
    const created = workspaceSummarySchema.parse(await res.json())
    expect(created.displayName).toBe('Marketing Team')
    expect(created.segment).toBe('marketing-team')
    // ADR-0019's canonical layer is minted HERE. A caller naming one would be
    // choosing the single identity that is not theirs to choose.
    expect(created.workspaceId).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/)

    const listed = listWorkspacesResponseSchema.parse(
      await (await app.request('/api/workspaces')).json(),
    )
    expect(listed.workspaces.map((w) => w.workspaceId)).toContain(created.workspaceId)
  })

  it('gives the second workspace of the same name an address of its own', async () => {
    const app = createWorkspacesRouter({ serverDeps })
    const first = workspaceSummarySchema.parse(
      await (await create(app, { displayName: 'Notes' })).json(),
    )
    const second = workspaceSummarySchema.parse(
      await (await create(app, { displayName: 'Notes' })).json(),
    )

    // A display name may repeat as often as its owner likes; the address it
    // derives may not.
    expect(first.displayName).toBe('Notes')
    expect(second.displayName).toBe('Notes')
    expect(first.segment).toBe('notes')
    expect(second.segment).not.toBe('notes')
    expect(second.segment).toBeDefined()
  })

  it('creates a workspace with NO segment when the name yields none', async () => {
    const app = createWorkspacesRouter({ serverDeps })
    // A name the segment charset cannot spell. ADR-0019 leaves the layer
    // absent rather than writing a mangled approximation — the workspace is
    // addressed by its canonical id until a rename gives it one.
    const created = workspaceSummarySchema.parse(
      await (await create(app, { displayName: '設計ノート' })).json(),
    )
    expect(created.displayName).toBe('設計ノート')
    expect(created.segment).toBeUndefined()
  })

  it('refuses a name that is empty once trimmed', async () => {
    const app = createWorkspacesRouter({ serverDeps })
    expect((await create(app, { displayName: '   ' })).status).toBe(400)
    expect((await create(app, {})).status).toBe(400)
  })
})

describe('PATCH /api/workspaces/:workspaceId', () => {
  async function created(app: ReturnType<typeof createWorkspacesRouter>, displayName: string) {
    const res = await app.request('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName }),
    })
    return workspaceSummarySchema.parse(await res.json())
  }

  async function patch(
    app: ReturnType<typeof createWorkspacesRouter>,
    handle: string,
    body: unknown,
  ) {
    return app.request(`/api/workspaces/${handle}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('renames both layers and answers with the workspace as it now stands', async () => {
    const app = createWorkspacesRouter({ serverDeps })
    const before = await created(app, 'Before')

    const res = await patch(app, before.workspaceId, { segment: 'after', displayName: 'After' })
    expect(res.status).toBe(200)
    expect(workspaceSummarySchema.parse(await res.json())).toEqual({
      workspaceId: before.workspaceId,
      segment: 'after',
      displayName: 'After',
    })
  })

  it('leaves a layer the body omits alone, rather than clearing it', async () => {
    const app = createWorkspacesRouter({ serverDeps })
    const before = await created(app, 'Keeps its url')
    expect(before.segment).toBe('keeps-its-url')

    const res = await patch(app, before.workspaceId, { displayName: 'Renamed' })
    const renamed = workspaceSummarySchema.parse(await res.json())
    expect(renamed.displayName).toBe('Renamed')
    expect(renamed.segment).toBe('keeps-its-url')
  })

  it('accepts the SEGMENT in the address, like every other addressed surface', async () => {
    const app = createWorkspacesRouter({ serverDeps })
    const before = await created(app, 'Addressed by segment')

    const res = await patch(app, 'addressed-by-segment', { displayName: 'Renamed through it' })
    expect(res.status).toBe(200)
    expect(workspaceSummarySchema.parse(await res.json()).workspaceId).toBe(before.workspaceId)
  })

  it('answers 404 for a workspace that does not exist', async () => {
    const app = createWorkspacesRouter({ serverDeps })
    const res = await patch(app, '01ARZ3NDEKTSV4RRFFQ69G5FAV', { displayName: 'Nobody' })
    expect(res.status).toBe(404)
  })

  it('refuses a segment another workspace holds, and changes nothing', async () => {
    const app = createWorkspacesRouter({ serverDeps })
    const other = await created(app, 'Held by someone else')
    const mine = await created(app, 'Mine')

    const res = await patch(app, mine.workspaceId, {
      segment: other.segment,
      displayName: 'Renamed anyway',
    })
    expect(res.status).toBe(409)

    // One refused OPERATION, not a partial one: the display name in the same
    // body must not have landed either.
    const listed = listWorkspacesResponseSchema.parse(
      await (await app.request('/api/workspaces')).json(),
    )
    const after = listed.workspaces.find((w) => w.workspaceId === mine.workspaceId)
    expect(after?.segment).toBe('mine')
    expect(after?.displayName).toBe('Mine')
  })

  it('accepts the workspace its OWN segment names, which is not a collision', async () => {
    const app = createWorkspacesRouter({ serverDeps })
    const before = await created(app, 'Unchanged')

    const res = await patch(app, before.workspaceId, {
      segment: before.segment,
      displayName: 'Named at last',
    })
    expect(res.status).toBe(200)
    expect(workspaceSummarySchema.parse(await res.json()).displayName).toBe('Named at last')
  })
})

// A switcher row that says only a name gives no reason to pick one workspace
// over another. The count is what makes the list readable — and it must agree
// with the list the document browser then shows, which is why a SHADOWED
// document counts: it is a document in the workspace, it appears in the
// listing with its mark, and a number that quietly omitted it would recreate
// the disagreement the mark exists to prevent.
describe('GET /api/workspaces document counts', () => {
  async function created(app: ReturnType<typeof createWorkspacesRouter>, displayName: string) {
    const res = await app.request('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName }),
    })
    return workspaceSummarySchema.parse(await res.json())
  }

  async function listed(app: ReturnType<typeof createWorkspacesRouter>) {
    return listWorkspacesResponseSchema.parse(await (await app.request('/api/workspaces')).json())
  }

  it('counts each workspace its own documents', async () => {
    const app = createWorkspacesRouter({ serverDeps })
    const two = await created(app, 'Two docs')
    const none = await created(app, 'No docs')

    for (const path of ['alpha', 'beta']) {
      await createTestDocument(serverDeps, { workspaceId: two.workspaceId, path })
    }

    const { workspaces } = await listed(app)
    expect(workspaces.find((w) => w.workspaceId === two.workspaceId)?.documentCount).toBe(2)
    // Zero is a real answer and must be REPORTED, not left absent: an empty
    // workspace is exactly the one a person needs to recognise in the list.
    expect(workspaces.find((w) => w.workspaceId === none.workspaceId)?.documentCount).toBe(0)
  })

  it('counts documents in folders, not just at the root', async () => {
    const app = createWorkspacesRouter({ serverDeps })
    const ws = await created(app, 'Nested')
    for (const path of ['top', 'folder/one', 'folder/deeper/two']) {
      await createTestDocument(serverDeps, { workspaceId: ws.workspaceId, path })
    }

    const { workspaces } = await listed(app)
    expect(workspaces.find((w) => w.workspaceId === ws.workspaceId)?.documentCount).toBe(3)
  })

  it('stops counting a document once it is deleted', async () => {
    const app = createWorkspacesRouter({ serverDeps })
    const ws = await created(app, 'Deletes')
    await createTestDocument(serverDeps, { workspaceId: ws.workspaceId, path: 'gone' })
    expect(
      (await listed(app)).workspaces.find((w) => w.workspaceId === ws.workspaceId)?.documentCount,
    ).toBe(1)

    await app.request(`/api/workspaces/${ws.workspaceId}/documents/gone`, { method: 'DELETE' })

    expect(
      (await listed(app)).workspaces.find((w) => w.workspaceId === ws.workspaceId)?.documentCount,
    ).toBe(0)
  })
})

// Found by hitting a REAL daemon, not by any test here: a workspace can sit in
// the registry with no workspace TREE yet. `listWorkspaces` returns the row and
// `listDocuments` throws for it, so counting every row turned one such
// workspace into a 500 for the WHOLE list — a listing that worked before the
// count was added.
//
// Every case above creates its workspaces THROUGH the route, which makes the
// tree as a side effect, so none of them could reach this state. The registry
// row is written directly here for exactly that reason.
describe('GET /api/workspaces with a registry row that has no tree', () => {
  async function registryRowOnly(workspaceId: string) {
    const { getDb } = await import('../../store/db/index.js')
    const { upsertWorkspaceRow } = await import('../../store/db/upsert-workspace.js')
    await upsertWorkspaceRow(await getDb(tmp.dir), workspaceId, {})
  }

  it('counts it as empty instead of failing the whole listing', async () => {
    const app = createWorkspacesRouter({ serverDeps })
    const withTree = workspaceSummarySchema.parse(
      await (
        await app.request('/api/workspaces', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ displayName: 'Has a tree' }),
        })
      ).json(),
    )
    await registryRowOnly('01ARZ3NDEKTSV4RRFFQ69G5FAV')

    const res = await app.request('/api/workspaces')
    expect(res.status).toBe(200)
    const { workspaces } = listWorkspacesResponseSchema.parse(await res.json())

    // The row is LISTED — dropping it would hide a workspace that exists.
    const treeless = workspaces.find((w) => w.workspaceId === '01ARZ3NDEKTSV4RRFFQ69G5FAV')
    expect(treeless).toBeDefined()
    // And counted as what it is: a workspace holding nothing.
    expect(treeless?.documentCount).toBe(0)
    // Its neighbour is unaffected — one row's missing tree must not cost the
    // others their counts.
    expect(workspaces.find((w) => w.workspaceId === withTree.workspaceId)?.documentCount).toBe(0)
  })
})
