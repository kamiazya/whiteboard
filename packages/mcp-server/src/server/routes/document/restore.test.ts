import { writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { Hono } from 'hono'
import { LoroDoc, LoroMap } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { withTempDataDir } from '../_test-helpers.js'

vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const tmp = withTempDataDir('whiteboard-restore-test-')

const { createRestoreRouter } = await import('./restore.js')
const { clearCache, peekDoc } = await import('../../store/doc-cache.js')
const { getDoc, saveDocument, getDocumentKind, loadDocument, onWorkspaceDocUpdated } = await import(
  '../../store/document-store.js'
)
const { countAliveNodes } = await import('@kamiazya/whiteboard-server-core')
const { createDocumentRouter } = await import('../document.js')
// Pre-load ws.js before any restore call, mirroring restore-race.test.ts's
// documented cycle workaround for document.ts's dynamic import.
await import('../ws.js')

beforeEach(() => {
  clearCache()
})
afterEach(() => {
  clearCache()
})

describe('restore router', () => {
  it('returns a Hono instance', () => {
    const app = createRestoreRouter()
    expect(app).toBeInstanceOf(Hono)
  })
})

// Builds a doc holding one text node per id and exports its full update from
// the empty version vector, so a caller can POST the whole doc as one update.
function nodesModelDocUpdate(nodeIds: string[]): Uint8Array {
  const doc = new LoroDoc()
  const vv0 = doc.version()
  writeSpatialCanvas(doc, {
    nodes: nodeIds.map((id) => ({
      id,
      type: 'text' as const,
      text: id,
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    })),
    edges: [],
  })
  return doc.export({ mode: 'update', from: vv0 }) as Uint8Array
}

describe('restore router (real node counts)', () => {
  it("restore into a brand-new targetPath responds with the past state's real node count", async () => {
    const app = createDocumentRouter({ autoVersionIntervalMs: 60_000 })

    const sourceDoc = new LoroDoc()
    const svv0 = sourceDoc.version()
    writeSpatialCanvas(sourceDoc, {
      nodes: [
        { id: 'n1', type: 'text', text: 'a', x: 0, y: 0, width: 10, height: 10 },
        { id: 'n2', type: 'text', text: 'b', x: 0, y: 0, width: 10, height: 10 },
      ],
      edges: [],
    })
    await app.request('/api/w/session1/document/canvas-a/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: sourceDoc.export({ mode: 'update', from: svv0 }),
    })
    const saveRes = await app.request('/api/workspaces/session1/documents/canvas-a/versions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'v1' }),
    })
    const saveBody = (await saveRes.json()) as { version: { id: string } }

    const restoreRes = await app.request(
      `/api/workspaces/session1/documents/canvas-a/versions/${saveBody.version.id}/restore`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetPath: 'canvas-new' }),
      },
    )
    expect(restoreRes.status).toBe(200)
    const restoreBody = (await restoreRes.json()) as { documentId: string; elementCount: number }
    expect(restoreBody.elementCount).toBe(2)
  })

  it("restore-overwrite into an existing targetPath responds with the reconciled target's real node count", async () => {
    const app = createDocumentRouter({ autoVersionIntervalMs: 60_000 })

    // Source canvas with one node, saved as a version.
    await app.request('/api/w/session1/document/canvas-a/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: nodesModelDocUpdate(['keep-me']),
    })
    const saveRes = await app.request('/api/workspaces/session1/documents/canvas-a/versions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'v1' }),
    })
    const saveBody = (await saveRes.json()) as { version: { id: string } }

    // Target canvas already exists with a different node.
    await app.request('/api/w/session1/document/canvas-b/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: nodesModelDocUpdate(['b-only']),
    })

    const restoreRes = await app.request(
      `/api/workspaces/session1/documents/canvas-a/versions/${saveBody.version.id}/restore`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetPath: 'canvas-b', overwrite: true }),
      },
    )
    expect(restoreRes.status).toBe(200)
    const restoreBody = (await restoreRes.json()) as { documentId: string; elementCount: number }

    // Reconcile-onto-live-doc is CRDT merge, not a straight overwrite, so
    // assert the response tracks whatever the live target doc actually
    // ended up holding rather than assuming an exact merged node set.
    const finalTargetDoc = await loadDocument('session1', 'canvas-b')
    expect(restoreBody.elementCount).toBe(countAliveNodes(finalTargetDoc))
    // And it must be the real (non-zero) count, not the retired stub's 0.
    expect(restoreBody.elementCount).toBeGreaterThan(0)
  })
})

describe('restore router (kind propagation)', () => {
  it("stamps the source's kind on a brand-new target so it opens in the right editor", async () => {
    const app = createDocumentRouter({ autoVersionIntervalMs: 60_000 })
    // A markdown document: its OKF body is a text node, so the restored
    // content alone cannot say which editor should open it.
    await saveDocument('session1', 'note-a', new LoroDoc(), { kind: 'markdown' })
    await app.request('/api/w/session1/document/note-a/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: nodesModelDocUpdate(['okf-body']),
    })
    const saveRes = await app.request('/api/workspaces/session1/documents/note-a/versions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'v1' }),
    })
    const { version } = (await saveRes.json()) as { version: { id: string } }

    const restoreRes = await app.request(
      `/api/workspaces/session1/documents/note-a/versions/${version.id}/restore`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetPath: 'note-restored' }),
      },
    )
    expect(restoreRes.status).toBe(200)
    expect(await getDocumentKind('session1', 'note-restored')).toBe('markdown')
  })

  it("records 'spatial' for a lazy-created document, and restore copies that recorded kind", async () => {
    const app = createDocumentRouter({ autoVersionIntervalMs: 60_000 })
    // The /update path lazy-creates the row; every document now lands on
    // the workspace tree with a kind (pre-kind rows were this project's own
    // data defect and the startup fold deletes them), and the spatial
    // editor is what opens a lazy-create — so 'spatial' is recorded, and a
    // restore-to-target copies the record rather than a guess.
    await app.request('/api/w/session1/document/unknown-a/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: nodesModelDocUpdate(['n1']),
    })
    expect(await getDocumentKind('session1', 'unknown-a')).toBe('spatial')

    const saveRes = await app.request('/api/workspaces/session1/documents/unknown-a/versions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'v1' }),
    })
    const { version } = (await saveRes.json()) as { version: { id: string } }

    const restoreRes = await app.request(
      `/api/workspaces/session1/documents/unknown-a/versions/${version.id}/restore`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetPath: 'unknown-restored' }),
      },
    )
    expect(restoreRes.status).toBe(200)
    expect(await getDocumentKind('session1', 'unknown-restored')).toBe('spatial')
  })
})

describe('POST /api/workspaces/:workspaceId/documents/:path/versions/:id/restore', () => {
  it('restores the past-state element set through POST /versions/:id/restore', async () => {
    const app = createDocumentRouter({ autoVersionIntervalMs: 60_000 })

    // Step 1: Write the initial one-element state through /update.
    const initial = new LoroDoc()
    const vv0 = initial.version()
    const list = initial.getMovableList('elements')
    const m0 = list.insertContainer(list.length, new LoroMap())
    m0.set('id', 'keep-me')
    m0.set('type', 'rectangle')
    initial.commit()
    await app.request('/api/w/session1/document/canvas-a/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: initial.export({ mode: 'update', from: vv0 }),
    })

    // Step 2: Save the current one-element state as v1.
    const saveRes = await app.request('/api/workspaces/session1/documents/canvas-a/versions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'v1' }),
    })
    const saveBody = (await saveRes.json()) as { version: { id: string } }
    const v1id = saveBody.version.id

    // Step 3: Add two more elements after v1.
    const vv1 = initial.version()
    const m1 = list.insertContainer(list.length, new LoroMap())
    m1.set('id', 'added-1')
    m1.set('type', 'ellipse')
    const m2 = list.insertContainer(list.length, new LoroMap())
    m2.set('id', 'added-2')
    m2.set('type', 'diamond')
    initial.commit()
    await app.request('/api/w/session1/document/canvas-a/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: initial.export({ mode: 'update', from: vv1 }),
    })

    // Step 4: Restore v1. The CRDT merge imports the past snapshot.
    const resRestore = await app.request(
      `/api/workspaces/session1/documents/canvas-a/versions/${v1id}/restore`,
      { method: 'POST' },
    )
    expect(resRestore.status).toBe(200)
  })

  it('evicts the cached doc when saveDocument fails during in-place restore, so a subsequent read does not serve the un-persisted reconcile', async () => {
    const app = createDocumentRouter({ autoVersionIntervalMs: 60_000 })

    // Step 1: seed with keep-me.
    const initial = new LoroDoc()
    const vv0 = initial.version()
    const list = initial.getMovableList('elements')
    const m0 = list.insertContainer(0, new LoroMap())
    m0.set('id', 'keep-me')
    initial.commit()
    await app.request('/api/w/session1/document/canvas-a/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: initial.export({ mode: 'update', from: vv0 }),
    })

    // Step 2: save v1.
    const saveRes = await app.request('/api/workspaces/session1/documents/canvas-a/versions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'v1' }),
    })
    const saveBody = (await saveRes.json()) as { version: { id: string } }

    // Step 3: add a second element after v1, so restoring v1 would tombstone it.
    const vv1 = initial.version()
    const m1 = list.insertContainer(list.length, new LoroMap())
    m1.set('id', 'added-after-v1')
    initial.commit()
    await app.request('/api/w/session1/document/canvas-a/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: initial.export({ mode: 'update', from: vv1 }),
    })

    expect(peekDoc('session1', 'canvas-a')).toBeDefined()

    // Fail the workspace-record save itself — the persistence step at the
    // end of saveDocument — after reconcile+commit have already mutated the
    // cached projection AND the live workspace doc.
    const { DocumentStoreWorkspaceDocs } = await import('@kamiazya/whiteboard-workspace-index')
    const saveSpy = vi
      .spyOn(DocumentStoreWorkspaceDocs.prototype, 'save')
      .mockRejectedValueOnce(new Error('simulated snapshot failure'))

    const restoreRes = await app.request(
      `/api/workspaces/session1/documents/canvas-a/versions/${saveBody.version.id}/restore`,
      { method: 'POST' },
    )
    saveSpy.mockRestore()

    expect(restoreRes.status).toBe(500)
    // The cache must be evicted: without eviction, the reconciled-but-never-
    // saved tombstone state would keep serving from memory.
    expect(peekDoc('session1', 'canvas-a')).toBeUndefined()

    const reloaded = await getDoc('session1', 'canvas-a')
    const ids = (reloaded.getMovableList('elements').toJSON() as Array<{ id: string }>)
      .map((el) => el.id)
      .sort()
    expect(ids).toEqual(['added-after-v1', 'keep-me'])
  })

  // Previously this spied `commit` on the cached live doc and asserted the
  // cache was EVICTED afterwards. That pinned a mechanism the restore no
  // longer has: the operation reconciles a fresh copy and only the keeper's
  // save touches the live projection, so a failure before that point leaves
  // nothing to evict. The guarantee this now pins is the stronger one the
  // design bought — a refused restore does not dirty the live document at
  // all — asserted on what a reader gets, not on cache bookkeeping. The
  // failure-DURING-persistence case, where the live doc is already mutated,
  // is the test above this one.
  it('a restore refused before persistence leaves the live document untouched and still served', async () => {
    const { getDefaultServerDeps } = await import('../../../di/default-server-deps.js')
    const deps = await getDefaultServerDeps()
    const real = deps.documentStore
    // Bound to the real store, not the proxy: the routed store keeps private
    // fields, which a proxy receiver would break.
    const refusing = new Proxy(real, {
      get(target, key, receiver) {
        if (key === 'saveSnapshot') {
          return async () => {
            throw new Error('simulated persistence refusal')
          }
        }
        const value = Reflect.get(target, key, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const app = createDocumentRouter({
      autoVersionIntervalMs: 60_000,
      serverDeps: { ...deps, documentStore: refusing },
    })

    const initial = new LoroDoc()
    const vv0 = initial.version()
    const list = initial.getMovableList('elements')
    const m0 = list.insertContainer(0, new LoroMap())
    m0.set('id', 'keep-me')
    initial.commit()
    await app.request('/api/w/session1/document/canvas-a/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: initial.export({ mode: 'update', from: vv0 }),
    })
    const saveRes = await app.request('/api/workspaces/session1/documents/canvas-a/versions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'v1' }),
    })
    const saveBody = (await saveRes.json()) as { version: { id: string } }

    const vv1 = initial.version()
    const m1 = list.insertContainer(list.length, new LoroMap())
    m1.set('id', 'added-after-v1')
    initial.commit()
    await app.request('/api/w/session1/document/canvas-a/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: initial.export({ mode: 'update', from: vv1 }),
    })

    expect(peekDoc('session1', 'canvas-a')).toBeDefined()
    const before = peekDoc('session1', 'canvas-a')!

    const restoreRes = await app.request(
      `/api/workspaces/session1/documents/canvas-a/versions/${saveBody.version.id}/restore`,
      { method: 'POST' },
    )
    expect(restoreRes.status).toBe(500)

    // Still cached, and the SAME instance: nothing was dirtied, so nothing
    // had to be thrown away.
    expect(peekDoc('session1', 'canvas-a')).toBe(before)
    const reloaded = await getDoc('session1', 'canvas-a')
    const ids = (reloaded.getMovableList('elements').toJSON() as Array<{ id: string }>)
      .map((el) => el.id)
      .sort()
    expect(ids).toEqual(['added-after-v1', 'keep-me'])
  })

  it('returns 404 when restoring a missing version id', async () => {
    const app = createDocumentRouter({ autoVersionIntervalMs: 60_000 })
    const res = await app.request(
      '/api/workspaces/session1/documents/canvas-a/versions/nonexistent/restore',
      { method: 'POST' },
    )
    expect(res.status).toBe(404)
  })

  it('returns 400 for an invalid version id', async () => {
    const app = createDocumentRouter({ autoVersionIntervalMs: 60_000 })
    const res = await app.request(
      '/api/workspaces/session1/documents/canvas-a/versions/bad.id/restore',
      { method: 'POST' },
    )
    expect(res.status).toBe(400)
  })
})

// targetPath + overwrite must reconcile onto the target's LIVE cached doc
// instead of replacing persistence, so connected clients stay on the same
// CRDT lineage and converge through the normal update broadcast.
describe('overwrite restore reconciles instead of replacing', () => {
  it('targetPath === path with overwrite:true reconciles the live doc in place and broadcasts an update', async () => {
    const app = createDocumentRouter({ autoVersionIntervalMs: 60_000 })

    // v1: one element.
    const initial = new LoroDoc()
    const vv0 = initial.version()
    const list = initial.getMovableList('elements')
    const m0 = list.insertContainer(0, new LoroMap())
    m0.set('id', 'keep-me')
    initial.commit()
    await app.request('/api/w/session1/document/canvas-a/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: initial.export({ mode: 'update', from: vv0 }),
    })
    const saveRes = await app.request('/api/workspaces/session1/documents/canvas-a/versions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'v1' }),
    })
    const saveBody = (await saveRes.json()) as { version: { id: string } }

    // Add a second element after v1.
    const vv1 = initial.version()
    const m1 = list.insertContainer(list.length, new LoroMap())
    m1.set('id', 'added-after-v1')
    initial.commit()
    await app.request('/api/w/session1/document/canvas-a/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: initial.export({ mode: 'update', from: vv1 }),
    })

    const docBefore = peekDoc('session1', 'canvas-a')
    expect(docBefore).toBeDefined()

    // The restore persists through the workspace record; its funnel — the
    // only fan-out left — carries the persisted bytes to subscribers.
    const funnelUpdates: Array<{ workspaceId: string; byteLength: number }> = []
    const stopFunnel = onWorkspaceDocUpdated((workspaceId, update) => {
      funnelUpdates.push({ workspaceId, byteLength: update.byteLength })
    })

    let restoreRes: Response
    try {
      restoreRes = await app.request(
        `/api/workspaces/session1/documents/canvas-a/versions/${saveBody.version.id}/restore`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetPath: 'canvas-a', overwrite: true }),
        },
      )
    } finally {
      stopFunnel()
    }
    expect(restoreRes.status).toBe(200)

    // Same object identity: the cached doc was mutated in place, not
    // replaced by a differently-lineaged document loaded from `past`.
    expect(peekDoc('session1', 'canvas-a')).toBe(docBefore)

    expect(funnelUpdates).toHaveLength(1)
    expect(funnelUpdates[0]?.workspaceId).toBe('session1')
    expect(funnelUpdates[0]?.byteLength).toBeGreaterThan(0)
  })

  it('targetPath === path WITHOUT overwrite still restores in place (same-path is never treated as a distinct target)', async () => {
    const app = createDocumentRouter({ autoVersionIntervalMs: 60_000 })

    const initial = new LoroDoc()
    const vv0 = initial.version()
    const list = initial.getMovableList('elements')
    const m0 = list.insertContainer(0, new LoroMap())
    m0.set('id', 'keep-me')
    initial.commit()
    await app.request('/api/w/session1/document/canvas-a/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: initial.export({ mode: 'update', from: vv0 }),
    })
    const saveRes = await app.request('/api/workspaces/session1/documents/canvas-a/versions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'v1' }),
    })
    const saveBody = (await saveRes.json()) as { version: { id: string } }

    const restoreRes = await app.request(
      `/api/workspaces/session1/documents/canvas-a/versions/${saveBody.version.id}/restore`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetPath: 'canvas-a' }),
      },
    )
    expect(restoreRes.status).toBe(200)
    const body = (await restoreRes.json()) as { ok: boolean }
    expect(body.ok).toBe(true)
  })

  it('restoring into a different existing canvas reconciles that canvas and broadcasts to it, not the source', async () => {
    const app = createDocumentRouter({ autoVersionIntervalMs: 60_000 })

    // Source canvas-a: v1 has only "keep-me".
    const sourceDoc = new LoroDoc()
    const svv0 = sourceDoc.version()
    const sourceList = sourceDoc.getMovableList('elements')
    const sm0 = sourceList.insertContainer(0, new LoroMap())
    sm0.set('id', 'keep-me')
    sourceDoc.commit()
    await app.request('/api/w/session1/document/canvas-a/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: sourceDoc.export({ mode: 'update', from: svv0 }),
    })
    const saveRes = await app.request('/api/workspaces/session1/documents/canvas-a/versions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'v1' }),
    })
    const saveBody = (await saveRes.json()) as { version: { id: string } }

    // Target canvas-b already exists with an unrelated element.
    const targetDoc = new LoroDoc()
    const tvv0 = targetDoc.version()
    const targetList = targetDoc.getMovableList('elements')
    const tm0 = targetList.insertContainer(0, new LoroMap())
    tm0.set('id', 'b-only')
    targetDoc.commit()
    await app.request('/api/w/session1/document/canvas-b/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: targetDoc.export({ mode: 'update', from: tvv0 }),
    })

    const funnelUpdates: Array<{ workspaceId: string }> = []
    const stopFunnel = onWorkspaceDocUpdated((workspaceId) => {
      funnelUpdates.push({ workspaceId })
    })

    let restoreRes: Response
    try {
      restoreRes = await app.request(
        `/api/workspaces/session1/documents/canvas-a/versions/${saveBody.version.id}/restore`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetPath: 'canvas-b', overwrite: true }),
        },
      )
    } finally {
      stopFunnel()
    }
    expect(restoreRes.status).toBe(200)
    const restoreBody = (await restoreRes.json()) as { documentId: string; elementCount: number }
    expect(restoreBody.documentId).toBe('session1/canvas-b')

    // One persisted write for the target reconcile; subscribers converge on
    // the document inside the workspace record rather than a path-addressed
    // frame.
    expect(funnelUpdates).toHaveLength(1)
    expect(funnelUpdates[0]?.workspaceId).toBe('session1')
  })

  it('restoring into a new (non-existent) target path still creates it', async () => {
    const app = createDocumentRouter({ autoVersionIntervalMs: 60_000 })

    const sourceDoc = new LoroDoc()
    const svv0 = sourceDoc.version()
    const sourceList = sourceDoc.getMovableList('elements')
    const sm0 = sourceList.insertContainer(0, new LoroMap())
    sm0.set('id', 'keep-me')
    sourceDoc.commit()
    await app.request('/api/w/session1/document/canvas-a/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: sourceDoc.export({ mode: 'update', from: svv0 }),
    })
    const saveRes = await app.request('/api/workspaces/session1/documents/canvas-a/versions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'v1' }),
    })
    const saveBody = (await saveRes.json()) as { version: { id: string } }

    const restoreRes = await app.request(
      `/api/workspaces/session1/documents/canvas-a/versions/${saveBody.version.id}/restore`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetPath: 'canvas-new' }),
      },
    )
    expect(restoreRes.status).toBe(200)
    const restoreBody = (await restoreRes.json()) as { documentId: string; elementCount: number }
    expect(restoreBody.documentId).toBe('session1/canvas-new')
    // The restored doc has one alive legacy element ("keep-me"); the
    // fixed countAliveNodes reports the real count instead of the
    // retired countElements(_doc) stub's always-0.
    expect(restoreBody.elementCount).toBe(1)
  })

  it('restoring a markdown-kind canvas into a new target path carries the source kind forward, not the spatial default', async () => {
    const app = createDocumentRouter({ autoVersionIntervalMs: 60_000 })

    await app.request('/api/workspaces/session1/documents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'canvas-a', kind: 'markdown' }),
    })

    const sourceDoc = new LoroDoc()
    const svv0 = sourceDoc.version()
    sourceDoc.getText('body').insert(0, 'hello')
    sourceDoc.commit()
    await app.request('/api/w/session1/document/canvas-a/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: sourceDoc.export({ mode: 'update', from: svv0 }),
    })
    const saveRes = await app.request('/api/workspaces/session1/documents/canvas-a/versions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'v1' }),
    })
    const saveBody = (await saveRes.json()) as { version: { id: string } }

    const restoreRes = await app.request(
      `/api/workspaces/session1/documents/canvas-a/versions/${saveBody.version.id}/restore`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetPath: 'canvas-new' }),
      },
    )
    expect(restoreRes.status).toBe(200)

    const listRes = await app.request('/api/workspaces/session1/documents')
    const listBody = (await listRes.json()) as {
      documents: { path: string; kind: string }[]
    }
    expect(listBody.documents.find((c) => c.path === 'canvas-new')?.kind).toBe('markdown')
  })

  it('restoring a markdown-kind canvas onto an existing spatial-kind target syncs the target kind to match the restored content', async () => {
    const app = createDocumentRouter({ autoVersionIntervalMs: 60_000 })

    await app.request('/api/workspaces/session1/documents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'canvas-a', kind: 'markdown' }),
    })
    await app.request('/api/workspaces/session1/documents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'canvas-b', kind: 'spatial' }),
    })

    const sourceDoc = new LoroDoc()
    const svv0 = sourceDoc.version()
    sourceDoc.getText('body').insert(0, 'hello')
    sourceDoc.commit()
    await app.request('/api/w/session1/document/canvas-a/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: sourceDoc.export({ mode: 'update', from: svv0 }),
    })
    const saveRes = await app.request('/api/workspaces/session1/documents/canvas-a/versions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'v1' }),
    })
    const saveBody = (await saveRes.json()) as { version: { id: string } }

    const restoreRes = await app.request(
      `/api/workspaces/session1/documents/canvas-a/versions/${saveBody.version.id}/restore`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetPath: 'canvas-b', overwrite: true }),
      },
    )
    expect(restoreRes.status).toBe(200)

    const listRes = await app.request('/api/workspaces/session1/documents')
    const listBody = (await listRes.json()) as {
      documents: { path: string; kind: string }[]
    }
    expect(listBody.documents.find((c) => c.path === 'canvas-b')?.kind).toBe('markdown')
  })

  it('restoring into an existing target path WITHOUT overwrite returns 409 output_exists', async () => {
    const app = createDocumentRouter({ autoVersionIntervalMs: 60_000 })

    const sourceDoc = new LoroDoc()
    const svv0 = sourceDoc.version()
    const sourceList = sourceDoc.getMovableList('elements')
    const sm0 = sourceList.insertContainer(0, new LoroMap())
    sm0.set('id', 'keep-me')
    sourceDoc.commit()
    await app.request('/api/w/session1/document/canvas-a/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: sourceDoc.export({ mode: 'update', from: svv0 }),
    })
    const saveRes = await app.request('/api/workspaces/session1/documents/canvas-a/versions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'v1' }),
    })
    const saveBody = (await saveRes.json()) as { version: { id: string } }

    await app.request('/api/w/session1/document/canvas-b/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: sourceDoc.export({ mode: 'update', from: svv0 }),
    })

    const restoreRes = await app.request(
      `/api/workspaces/session1/documents/canvas-a/versions/${saveBody.version.id}/restore`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetPath: 'canvas-b' }),
      },
    )
    expect(restoreRes.status).toBe(409)
    const body = (await restoreRes.json()) as { error: string }
    expect(body.error).toBe('output_exists')
  })

  // The overlay a client shows while a restore runs is driven by these two
  // messages, and until now nothing asserted the server SENDS them. The
  // consumer side is well covered — `sse-backend`, `daemon-backend` and
  // apps/web's sync hooks all test what happens when one ARRIVES — so a
  // change that stopped emitting them would leave every one of those tests
  // green while the overlay silently stopped appearing and, worse, stopped
  // being dismissed.
  it('brackets a restore with restore_started and restore_complete for a connected client', async () => {
    const app = createDocumentRouter({ autoVersionIntervalMs: 60_000 })
    const initial = new LoroDoc()
    const vv0 = initial.version()
    writeSpatialCanvas(initial, {
      nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 80, height: 40, text: 'before' }],
      edges: [],
    })
    initial.commit()
    await app.request('/api/w/session1/document/canvas-a/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: initial.export({ mode: 'update', from: vv0 }),
    })
    const saveRes = await app.request('/api/workspaces/session1/documents/canvas-a/versions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'v1' }),
    })
    const { version } = (await saveRes.json()) as { version: { id: string } }

    const sent: string[] = []
    const socket = {
      send: (data: unknown) => {
        if (typeof data === 'string') sent.push(data)
      },
      on: () => {},
      close: () => {},
    }
    const { handleWsUpgrade } = await import('../ws.js')
    await handleWsUpgrade(
      { url: '/ws/session1/canvas-a', headers: { host: 'localhost:3099' } } as never,
      socket as never,
    )
    sent.length = 0

    const res = await app.request(
      `/api/workspaces/session1/documents/canvas-a/versions/${version.id}/restore`,
      { method: 'POST' },
    )
    expect(res.status).toBe(200)

    const phases = sent
      .flatMap((raw) => {
        try {
          return [JSON.parse(raw) as { type?: string }]
        } catch {
          return []
        }
      })
      .map((m) => m.type)
      .filter((t) => t === 'restore_started' || t === 'restore_complete')
    // Both, and in that order: `complete` is what releases the overlay, so a
    // restore that only announced its start would lock the client forever.
    expect(phases).toEqual(['restore_started', 'restore_complete'])
  })
})
