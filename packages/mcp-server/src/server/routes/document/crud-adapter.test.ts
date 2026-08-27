/**
 * ADR-0018: the HTTP document routes are ADAPTERS over the `wb_document_*`
 * operations, not second implementations of them.
 *
 * The two used to be separate code paths performing the same delete, and
 * only one of them cleaned up (#1035). Sharing the pieces closed that gap
 * one piece at a time; sharing the OPERATION is what stops the next piece
 * from drifting, because there is no longer a second sequence to forget to
 * update.
 *
 * Asserted through the seam the operation goes through rather than on the
 * rows afterwards: identical end state is exactly what the two divergent
 * implementations produced right up until one of them grew a step.
 */
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { withTempDataDir } from '../_test-helpers.js'

const tmp = withTempDataDir('whiteboard-delete-adapter-')

vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { saveDocument } = await import('../../store/document-store.js')
const { getDb } = await import('../../store/db/index.js')
const { prepareDataDir } = await import('../../store/db/prepare.js')
const { createContainer, resolveServerDeps } = await import('../../../di/container.js')
const { createStoreLocalModule } = await import('../../../di/store-local.module.js')
const { createWorkspacesRouter } = await import('./workspaces.js')

async function depsRecordingTeardown(): Promise<{
  deps: Awaited<ReturnType<typeof resolveServerDeps>>
  entered: string[]
  cleaned: string[]
}> {
  const db = await getDb(tmp.dir)
  const deps = resolveServerDeps(createContainer(createStoreLocalModule({ db, blobDir: tmp.dir })))
  const entered: string[] = []
  const cleaned: string[] = []
  const real = deps.documentTeardown
  deps.documentTeardown = {
    around(input, deleteDocument) {
      entered.push(`${input.workspaceId}:${input.path}`)
      return real.around(input, async () => {
        const result = await deleteDocument()
        // Recorded INSIDE the bracket, after the delete returns: a refusal
        // throws past this line, which is what "the cleanup did not run"
        // means and the only way to observe it from out here.
        cleaned.push(`${input.workspaceId}:${input.path}`)
        return result
      })
    },
  }
  return { deps, entered, cleaned }
}

// A partial spy over the REAL index. Object.create is not enough here: the
// tree index holds private fields, so any method reached through the
// prototype chain with a detached receiver throws "Receiver must be an
// instance of class". The Proxy leaves the receiver as the instance.
function spyIndex<T extends object>(inner: T, overrides: Partial<T>): T {
  return new Proxy(inner, {
    get(target, key, _receiver) {
      if (key in overrides) return overrides[key as keyof T]
      const value = Reflect.get(target, key, target)
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value
    },
  }) as T
}

async function depsRecordingCreate(bootstrapWorkspace = true): Promise<{
  deps: Awaited<ReturnType<typeof resolveServerDeps>>
  created: string[]
  listed: string[]
}> {
  // The delete cases reach a migrated schema through `saveDocument`'s own
  // `dbReady`; these create nothing first, so they have to migrate here.
  await prepareDataDir(tmp.dir)
  const db = await getDb(tmp.dir)
  const deps = resolveServerDeps(createContainer(createStoreLocalModule({ db, blobDir: tmp.dir })))
  if (bootstrapWorkspace) await deps.documentIndex.createWorkspace({ workspaceId: 'ws-1' })
  const created: string[] = []
  const listed: string[] = []
  const inner = deps.documentIndex
  const index = spyIndex(inner, {
    createDocument: async (input) => {
      created.push(`${input.workspaceId}:${input.path}`)
      return await inner.createDocument(input)
    },
    listDocuments: async (input) => {
      listed.push(input.workspaceId)
      return await inner.listDocuments(input)
    },
  })
  return { deps: { ...deps, documentIndex: index }, created, listed }
}

describe('GET /api/workspaces', () => {
  it('lists through the injected index rather than the module store', async () => {
    const { deps } = await depsRecordingCreate()
    await deps.documentIndex.createWorkspace({ workspaceId: 'ws-2' })
    const listed: string[] = []
    const inner = deps.documentIndex
    const index = spyIndex(inner, {
      listWorkspaces: async () => {
        listed.push('called')
        return await inner.listWorkspaces()
      },
    })
    const app = createWorkspacesRouter({ serverDeps: { ...deps, documentIndex: index } })

    const res = await app.request('/api/workspaces')

    expect(res.status).toBe(200)
    // Both indexes read the same database, so the response alone cannot tell
    // the injected one from the module-level store.
    expect(listed).toEqual(['called'])
    const body = (await res.json()) as { workspaces: { workspaceId: string }[] }
    expect(body.workspaces.map((w) => w.workspaceId).sort()).toEqual(['ws-1', 'ws-2'])
  })
})

describe('GET /api/workspaces/:workspaceId/documents', () => {
  it('lists through the injected operation, carrying kind and updatedAt', async () => {
    const { deps, listed } = await depsRecordingCreate()
    await deps.documentIndex.createDocument({ workspaceId: 'ws-1', path: 'a', kind: 'markdown' })
    const app = createWorkspacesRouter({ serverDeps: deps })

    const res = await app.request('/api/workspaces/ws-1/documents')

    expect(res.status).toBe(200)
    // Reaching the same database is not the same as reaching the injected
    // index: the module-level store reads these very rows, so without this the
    // case passes either way.
    expect(listed).toEqual(['ws-1'])
    const body = (await res.json()) as { documents: Record<string, unknown>[] }
    expect(body.documents).toHaveLength(1)
    expect(body.documents[0]).toMatchObject({ path: 'a', kind: 'markdown' })
    // The daemon's index owns a timestamp, so this surface must still report
    // one — the field is optional on the port for the browser's sake, not
    // because the daemon may omit it.
    expect(typeof body.documents[0]?.updatedAt).toBe('string')
  })

  // "Empty" and "never registered" are different answers, and conflating them
  // is what let a stale pairing render as an empty workspace with a Create
  // button. The operation raises it; this surface translates it.
  it('answers 404 for a workspace that was never registered', async () => {
    const { deps } = await depsRecordingCreate()
    const app = createWorkspacesRouter({ serverDeps: deps })

    const res = await app.request('/api/workspaces/never-made/documents')

    expect(res.status).toBe(404)
  })
})

describe('POST /api/workspaces/:workspaceId/documents', () => {
  // Same reasoning as the delete below: creating a document twice over — once
  // in the route, once in `wb_document_create` — is how the two drifted the
  // first time. Asserted through the index the operation writes through,
  // because the resulting row looks identical either way.
  it('creates through the injected operation rather than its own sequence', async () => {
    const { deps, created } = await depsRecordingCreate()
    const app = createWorkspacesRouter({ serverDeps: deps })

    const res = await app.request('/api/workspaces/ws-1/documents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'fresh', kind: 'spatial' }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ path: 'fresh' })
    expect(created).toEqual(['ws-1:fresh'])

    // Reaching the injected index is necessary but not sufficient: a route
    // calling `documentIndex.createDocument` directly would satisfy the line
    // above and leave a placement with no document under it. Only the
    // operation persists the bytes, so the snapshot is what says the whole
    // operation ran rather than its first step.
    const entry = await deps.documentIndex.resolveDocument({
      workspaceId: 'ws-1',
      path: 'fresh',
    })
    const snapshot = await deps.documentStore.loadSnapshot({
      docRef: { kind: 'document', workspaceId: 'ws-1', documentId: entry?.documentId ?? 'missing' },
    })
    expect(snapshot).not.toBeNull()
  })

  // The workspace bootstrap is this surface's own long-standing behaviour:
  // `saveDocument` upserted the workspace row on the way past, so posting
  // into one that does not exist yet has always worked here. The operation
  // makes it an explicit flag, and a flag nothing exercises is a flag that
  // gets dropped — removing `createWorkspace: true` left every other case in
  // this file green.
  it('creates the workspace on the way past, as this surface always has', async () => {
    const { deps } = await depsRecordingCreate(false)
    const app = createWorkspacesRouter({ serverDeps: deps })

    const res = await app.request('/api/workspaces/ws-1/documents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'first-ever', kind: 'spatial' }),
    })

    expect(res.status).toBe(200)
    const entries = await deps.documentIndex.listDocuments({ workspaceId: 'ws-1' })
    expect(entries.map((e) => e.path)).toEqual(['first-ever'])
  })

  it('answers 409 for a path already taken', async () => {
    const { deps } = await depsRecordingCreate()
    const app = createWorkspacesRouter({ serverDeps: deps })
    const body = JSON.stringify({ path: 'twice', kind: 'spatial' })
    const headers = { 'Content-Type': 'application/json' }

    const first = await app.request('/api/workspaces/ws-1/documents', {
      method: 'POST',
      headers,
      body,
    })
    expect(first.status).toBe(200)

    const second = await app.request('/api/workspaces/ws-1/documents', {
      method: 'POST',
      headers,
      body,
    })
    expect(second.status).toBe(409)
  })

  // A blank name means "no name" — the rule `setDocumentDisplayName` held
  // before the route delegated. Measured rather than assumed: passing a blank
  // through does not fail, it STORES an empty name, which `DocumentEntry.name`
  // declares as `z.string().min(1)` and so is a value the port says cannot
  // exist. The adapter has to trim and omit.
  it('creates an unnamed document for a blank name instead of storing an empty one', async () => {
    const { deps } = await depsRecordingCreate()
    const app = createWorkspacesRouter({ serverDeps: deps })

    const res = await app.request('/api/workspaces/ws-1/documents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'blank-name', kind: 'spatial', name: '   ' }),
    })

    expect(res.status).toBe(200)
    const entry = await deps.documentIndex.resolveDocument({
      workspaceId: 'ws-1',
      path: 'blank-name',
    })
    expect(entry?.name).toBeUndefined()
  })
})

describe('PUT /api/workspaces/:workspaceId/documents/:path/path', () => {
  async function depsRecordingMove(): Promise<{
    deps: Awaited<ReturnType<typeof resolveServerDeps>>
    moved: string[]
  }> {
    await prepareDataDir(tmp.dir)
    const db = await getDb(tmp.dir)
    const deps = resolveServerDeps(
      createContainer(createStoreLocalModule({ db, blobDir: tmp.dir })),
    )
    const moved: string[] = []
    const inner2 = deps.documentIndex
    const index = spyIndex(inner2, {
      moveDocument: async (input) => {
        moved.push(`${input.from}->${input.to}`)
        await inner2.moveDocument(input)
      },
    })
    return { deps: { ...deps, documentIndex: index }, moved }
  }

  it('renames through the injected operation rather than its own sequence', async () => {
    const { deps, moved } = await depsRecordingMove()
    await deps.documentIndex.createWorkspace({ workspaceId: 'ws-1' })
    await deps.documentIndex.createDocument({ workspaceId: 'ws-1', path: 'plan', kind: 'spatial' })
    const app = createWorkspacesRouter({ serverDeps: deps })

    const res = await app.request('/api/workspaces/ws-1/documents/plan/path', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'archive' }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ path: 'archive' })
    expect(moved).toEqual(['plan->archive'])
  })

  it('answers 404 for a path that names nothing', async () => {
    const { deps, moved } = await depsRecordingMove()
    await deps.documentIndex.createWorkspace({ workspaceId: 'ws-1' })
    const app = createWorkspacesRouter({ serverDeps: deps })

    const res = await app.request('/api/workspaces/ws-1/documents/absent/path', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'elsewhere' }),
    })

    expect(res.status).toBe(404)
    expect(moved).toEqual(['absent->elsewhere'])
  })

  // The collision is on a PRODUCED path, not the one the caller named: moving
  // `plan` to `archive` collides because `archive/child` is taken, while
  // `archive` itself is free. Naming `archive` in the error would send the
  // caller to retry the one thing that was never the problem, so the message
  // the operation raised is forwarded rather than rebuilt.
  it('forwards the produced colliding path in the 409, not the requested one', async () => {
    const { deps } = await depsRecordingMove()
    await deps.documentIndex.createWorkspace({ workspaceId: 'ws-1' })
    for (const path of ['plan', 'plan/child', 'archive/child']) {
      await deps.documentIndex.createDocument({ workspaceId: 'ws-1', path, kind: 'spatial' })
    }
    const app = createWorkspacesRouter({ serverDeps: deps })

    const res = await app.request('/api/workspaces/ws-1/documents/plan/path', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'archive' }),
    })

    expect(res.status).toBe(409)
    const body = (await res.json()) as { title?: string }
    expect(body.title).toContain('archive/child')
  })

  it('answers 400 for a move into the document own subtree', async () => {
    const { deps } = await depsRecordingMove()
    await deps.documentIndex.createWorkspace({ workspaceId: 'ws-1' })
    await deps.documentIndex.createDocument({ workspaceId: 'ws-1', path: 'plan', kind: 'spatial' })
    const app = createWorkspacesRouter({ serverDeps: deps })

    const res = await app.request('/api/workspaces/ws-1/documents/plan/path', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'plan/inside' }),
    })

    expect(res.status).toBe(400)
  })
})

describe('DELETE /api/workspaces/:workspaceId/documents/:path', () => {
  beforeEach(async () => {
    await saveDocument('ws-1', 'doomed', new LoroDoc())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('deletes through the injected operation rather than its own sequence', async () => {
    const { deps, entered, cleaned } = await depsRecordingTeardown()
    const app = createWorkspacesRouter({ serverDeps: deps })

    const res = await app.request('/api/workspaces/ws-1/documents/doomed', { method: 'DELETE' })

    expect(res.status).toBe(200)
    expect(entered).toEqual(['ws-1:doomed'])
    expect(cleaned).toEqual(['ws-1:doomed'])
  })

  // The refusal has to travel OUT of the operation and past the bracket's
  // cleanup — a refused delete destroys nothing (#1066). Covered here rather
  // than only through the default wiring, because the seam is the only place
  // "the cleanup did not run" is observable at all.
  it('surfaces the descendant refusal as 409 without entering cleanup', async () => {
    await saveDocument('ws-1', 'doomed/child', new LoroDoc())
    const { deps, entered, cleaned } = await depsRecordingTeardown()
    const app = createWorkspacesRouter({ serverDeps: deps })

    const res = await app.request('/api/workspaces/ws-1/documents/doomed', { method: 'DELETE' })

    expect(res.status).toBe(409)
    expect((await res.json()) as { title?: string }).toMatchObject({
      title: expect.stringContaining('doomed/child'),
    })
    expect(entered).toEqual(['ws-1:doomed'])
    expect(cleaned).toEqual([])
  })

  it('still answers 404 for a path that names nothing', async () => {
    const { deps, entered } = await depsRecordingTeardown()
    const app = createWorkspacesRouter({ serverDeps: deps })

    const res = await app.request('/api/workspaces/ws-1/documents/never-existed', {
      method: 'DELETE',
    })

    expect(res.status).toBe(404)
    // A delete that found nothing must not enter teardown: the cleanup would
    // be reaching for files belonging to a document it never identified.
    expect(entered).toEqual([])
  })
})
