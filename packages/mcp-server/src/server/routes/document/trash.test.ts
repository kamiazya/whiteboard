/**
 * The trash surface: what a delete evacuated, listed and restorable.
 *
 * The machinery (evacuate-before-remove, restore-as-copy under the SAME
 * documentId) lives in workspace-index and is conformance-tested there; what
 * this file pins is the REACH — the HTTP adapter a human's Restore button
 * calls, end to end through the real container deps and the real delete
 * route.
 */

import {
  listTrashResponseSchema,
  purgeTrashEntryResponseSchema,
  restoreTrashResponseSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/document'
import {
  readSpatialCanvas,
  readTrashEntries,
  recordTrashEntry,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { nodeText } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import {
  chunkSnapshot,
  DEFAULT_SNAPSHOT_MAX_CHUNK_BYTES,
  hasDocumentTrash,
  reassembleSnapshot,
} from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { storeMemoryModule } from '../../../shared/test-utils/store-memory.module.js'
import { testDocumentRouterOptions, withTempDataDir } from '../_test-helpers.js'

const tmp = withTempDataDir('whiteboard-trash-test-')

vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { saveDocument, resolveDocumentIdAtPath } = await import('../../store/document-store.js')
const { clearDocCacheForTests } = await import('../../store/doc-cache.js')
const { createDocumentRouter } = await import('../document.js')
const { createTrashRouter } = await import('./trash.js')
const { createContainer, resolveServerDeps } = await import('../../../di/container.js')
const { createSelfHostStoreLocalModule } = await import('../../../di/store-local.module.js')
const { prepareDataDir } = await import('../../store/db/prepare.js')
const { getDb } = await import('../../store/db/index.js')

beforeEach(() => {
  clearDocCacheForTests()
})

function canvasDoc(text: string): LoroDoc {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, {
    nodes: [textNode({ id: 'n1', x: 0, y: 0, width: 80, height: 40, text })],
    edges: [],
  })
  return doc
}

async function realDeps() {
  await prepareDataDir(tmp.dir)
  const db = await getDb(tmp.dir)
  return resolveServerDeps(createContainer(createSelfHostStoreLocalModule(db, tmp.dir)))
}

async function appWithRealDeps(deps?: Awaited<ReturnType<typeof realDeps>>) {
  const served = deps ?? (await realDeps())
  // The store-local composition is the trash-capable one — pinned here so a
  // regression in the DI's structural capability detection fails loudly,
  // rather than as a cascade of 501s in the tests below.
  expect(hasDocumentTrash(served.documentIndex)).toBe(true)
  return createDocumentRouter(testDocumentRouterOptions({ serverDeps: served }))
}

type App = Awaited<ReturnType<typeof appWithRealDeps>>

/** The node texts of the canvas a page opening `path` would be served. */
async function servedTexts(app: App, WS: string, path: string): Promise<string[]> {
  const snap = await app.request(`/api/w/${WS}/document/${path}/snapshot`)
  expect(snap.status).toBe(200)
  const doc = new LoroDoc()
  doc.import(new Uint8Array(await snap.arrayBuffer()))
  return readSpatialCanvas(doc).nodes.map((node) => nodeText(node) ?? node.id)
}

async function saveVersion(app: App, WS: string, path: string): Promise<string> {
  const saved = await app.request(`/api/workspaces/${WS}/documents/${path}/versions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  expect(saved.status).toBe(200)
  return ((await saved.json()) as { version: { id: string } }).version.id
}

async function listedVersionIds(app: App, WS: string, path: string): Promise<string[]> {
  const listed = await app.request(`/api/workspaces/${WS}/documents/${path}/versions`)
  expect(listed.status).toBe(200)
  return ((await listed.json()) as { versions: { id: string }[] }).versions.map((v) => v.id)
}

/** The stored rows themselves, so a row no listing can reach still counts. */
async function versionRowDocumentIds(WS: string): Promise<string[]> {
  const db = await getDb(tmp.dir)
  const rows = await db
    .selectFrom('versions')
    .select(['documentId'])
    .where('workspaceId', '=', WS)
    .execute()
  return rows.map((row) => row.documentId).sort()
}

/**
 * What a tab left open on a document deleted elsewhere does next: act on the
 * path it still shows. Each call is refused, and a refusal must leave nothing
 * behind that a later restore of the same path would be served as.
 */
const STALE_TAB_CALLS = {
  'saves a version': async (app: App, WS: string) =>
    app.request(`/api/workspaces/${WS}/documents/doomed/versions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }),
  'restores a version': async (app: App, WS: string, versionId: string) =>
    app.request(`/api/workspaces/${WS}/documents/doomed/versions/${versionId}/restore`, {
      method: 'POST',
    }),
}

async function trashBehindAStaleTab(staleCall: keyof typeof STALE_TAB_CALLS) {
  const WS = `ws-trash-stale-${staleCall.replaceAll(' ', '-')}`
  await saveDocument(WS, 'doomed', canvasDoc('precious'), { kind: 'spatial' })
  const documentId = await resolveDocumentIdAtPath(WS, 'doomed')
  const deps = await realDeps()
  const app = await appWithRealDeps(deps)
  const saved = await app.request(`/api/workspaces/${WS}/documents/doomed/versions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  const versionId = ((await saved.json()) as { version: { id: string } }).version.id
  await app.request(`/api/workspaces/${WS}/documents/doomed`, { method: 'DELETE' })
  expect((await STALE_TAB_CALLS[staleCall](app, WS, versionId)).status).toBe(404)
  const restored = await app.request(`/api/workspaces/${WS}/trash/${documentId}/restore`, {
    method: 'POST',
  })
  expect(restored.status).toBe(200)
  return { WS, app, deps, documentId: documentId as string }
}

describe('trash routes', () => {
  it('a deleted document is listed in the trash and restore brings it back under the SAME documentId', async () => {
    const WS = 'ws-trash'
    await saveDocument(WS, 'keep', canvasDoc('kept'), { kind: 'spatial' })
    await saveDocument(WS, 'doomed', canvasDoc('to delete'), { kind: 'spatial' })
    const documentId = await resolveDocumentIdAtPath(WS, 'doomed')
    expect(documentId).not.toBeNull()
    const app = await appWithRealDeps()

    const del = await app.request(`/api/workspaces/${WS}/documents/doomed`, { method: 'DELETE' })
    expect(del.status).toBe(200)

    const listed = await app.request(`/api/workspaces/${WS}/trash`)
    expect(listed.status).toBe(200)
    const body = listTrashResponseSchema.parse(await listed.json())
    expect(body.entries.map((entry) => entry.documentId)).toEqual([documentId])
    expect(body.entries[0]?.path).toBe('doomed')
    expect(body.entries[0]?.deletedAt).toBeGreaterThan(0)

    const restored = await app.request(`/api/workspaces/${WS}/trash/${documentId}/restore`, {
      method: 'POST',
    })
    expect(restored.status).toBe(200)
    const restoredBody = restoreTrashResponseSchema.parse(await restored.json())
    expect(restoredBody.restored.documentId).toBe(documentId)
    expect(restoredBody.restored.path).toBe('doomed')

    // The identity survives: the old address resolves to the old document.
    expect(await resolveDocumentIdAtPath(WS, 'doomed')).toBe(documentId)
    // And the trash no longer lists it.
    const after = listTrashResponseSchema.parse(
      await (await app.request(`/api/workspaces/${WS}/trash`)).json(),
    )
    expect(after.entries).toEqual([])
  })

  it.each(
    Object.keys(STALE_TAB_CALLS) as (keyof typeof STALE_TAB_CALLS)[],
  )('a restored document is served with its content after a stale tab %s on its path', async (staleCall) => {
    const { WS, app } = await trashBehindAStaleTab(staleCall)

    expect(await servedTexts(app, WS, 'doomed')).toEqual(['precious'])
  })

  it("an agent's load-modify-save after the restore keeps the restored content", async () => {
    const { WS, app, deps, documentId } = await trashBehindAStaleTab('saves a version')
    const docRef = { kind: 'document' as const, workspaceId: WS, documentId }
    const loaded = await deps.documentStore.loadSnapshot({ docRef })
    const agentDoc = new LoroDoc()
    if (loaded !== null) agentDoc.import(reassembleSnapshot(loaded.manifest, loaded.chunks))
    const canvas = readSpatialCanvas(agentDoc)
    const note = textNode({ id: 'n2', x: 100, y: 0, width: 80, height: 40, text: 'agent note' })
    writeSpatialCanvas(agentDoc, { ...canvas, nodes: [...canvas.nodes, note] })
    const bytes = new Uint8Array(agentDoc.export({ mode: 'snapshot' }))
    await deps.documentStore.saveSnapshot({
      docRef,
      ...chunkSnapshot(bytes, DEFAULT_SNAPSHOT_MAX_CHUNK_BYTES),
      frontier: new Uint8Array(agentDoc.oplogVersion().encode()),
    })
    clearDocCacheForTests()

    expect(await servedTexts(app, WS, 'doomed')).toEqual(['precious', 'agent note'])
  })

  it('purging a trashed document removes it from the trash for good, and it cannot be restored', async () => {
    const WS = 'ws-trash-purge'
    await saveDocument(WS, 'doomed', canvasDoc('to destroy'), { kind: 'spatial' })
    await saveDocument(WS, 'kept', canvasDoc('stays'), { kind: 'spatial' })
    const doomedId = await resolveDocumentIdAtPath(WS, 'doomed')
    const keptId = await resolveDocumentIdAtPath(WS, 'kept')
    const app = await appWithRealDeps()
    await app.request(`/api/workspaces/${WS}/documents/doomed`, { method: 'DELETE' })
    await app.request(`/api/workspaces/${WS}/documents/kept`, { method: 'DELETE' })

    const purged = await app.request(`/api/workspaces/${WS}/trash/${doomedId}`, {
      method: 'DELETE',
    })

    expect(purged.status).toBe(200)
    expect(purgeTrashEntryResponseSchema.parse(await purged.json()).purged.documentId).toBe(
      doomedId,
    )
    const listed = listTrashResponseSchema.parse(
      await (await app.request(`/api/workspaces/${WS}/trash`)).json(),
    )
    expect(listed.entries.map((entry) => entry.documentId)).toEqual([keptId])
    const restore = await app.request(`/api/workspaces/${WS}/trash/${doomedId}/restore`, {
      method: 'POST',
    })
    expect(restore.status).toBe(404)
    // Only the named entry went.
    const keptRestore = await app.request(`/api/workspaces/${WS}/trash/${keptId}/restore`, {
      method: 'POST',
    })
    expect(keptRestore.status).toBe(200)
  })

  it('answers 409, not 404, for a trash entry whose documentId the workspace already places', async () => {
    const WS = 'ws-trash-restore-placed'
    await saveDocument(WS, 'twice', canvasDoc('live copy'), { kind: 'spatial' })
    const documentId = (await resolveDocumentIdAtPath(WS, 'twice')) as string
    const deps = await realDeps()
    const app = await appWithRealDeps(deps)
    await app.request(`/api/workspaces/${WS}/documents/twice`, { method: 'DELETE' })
    const record = await deps.workspaceDocuments.get(WS)
    const [entry] = readTrashEntries(record)
    if (entry === undefined) throw new Error('the delete recorded no trash entry')
    await app.request(`/api/workspaces/${WS}/trash/${documentId}/restore`, { method: 'POST' })
    // The row a merge from another replica can leave beside the live
    // document: same documentId, still in the trash.
    const placed = await deps.workspaceDocuments.get(WS)
    recordTrashEntry(placed, entry)
    await deps.workspaceDocuments.save(WS, placed)

    const again = await app.request(`/api/workspaces/${WS}/trash/${documentId}/restore`, {
      method: 'POST',
    })

    expect(again.status).toBe(409)
    expect(((await again.json()) as { title: string }).title).toContain('twice')
    expect(await resolveDocumentIdAtPath(WS, 'twice')).toBe(documentId)
  })

  it('a restore from the trash brings the saved versions back with the document', async () => {
    const WS = 'ws-trash-versions-restore'
    await saveDocument(WS, 'doomed', canvasDoc('versioned'), { kind: 'spatial' })
    const documentId = await resolveDocumentIdAtPath(WS, 'doomed')
    const app = await appWithRealDeps()
    const versionId = await saveVersion(app, WS, 'doomed')

    await app.request(`/api/workspaces/${WS}/documents/doomed`, { method: 'DELETE' })
    const restored = await app.request(`/api/workspaces/${WS}/trash/${documentId}/restore`, {
      method: 'POST',
    })

    expect(restored.status).toBe(200)
    expect(await listedVersionIds(app, WS, 'doomed')).toEqual([versionId])
    // Listed AND openable: the version still reads the state it saved.
    const past = await app.request(
      `/api/workspaces/${WS}/documents/doomed/versions/${versionId}/document`,
    )
    expect(past.status).toBe(200)
    expect(JSON.stringify(await past.json())).toContain('versioned')
  })

  it("purging a trashed document drops its saved versions, and only that document's", async () => {
    const WS = 'ws-trash-versions-purge'
    await saveDocument(WS, 'doomed', canvasDoc('to destroy'), { kind: 'spatial' })
    await saveDocument(WS, 'kept', canvasDoc('stays'), { kind: 'spatial' })
    const doomedId = await resolveDocumentIdAtPath(WS, 'doomed')
    const keptId = await resolveDocumentIdAtPath(WS, 'kept')
    const app = await appWithRealDeps()
    await saveVersion(app, WS, 'doomed')
    await saveVersion(app, WS, 'kept')
    await app.request(`/api/workspaces/${WS}/documents/doomed`, { method: 'DELETE' })
    // Kept through the delete, so the purge below is what has to remove them.
    expect(await versionRowDocumentIds(WS)).toEqual([doomedId, keptId].sort())

    const purged = await app.request(`/api/workspaces/${WS}/trash/${doomedId}`, {
      method: 'DELETE',
    })

    expect(purged.status).toBe(200)
    expect(await versionRowDocumentIds(WS)).toEqual([keptId])
  })

  it('refuses to purge a live document, or an entry already purged, with a 404', async () => {
    const WS = 'ws-trash-purge-refused'
    await saveDocument(WS, 'live', canvasDoc('still here'), { kind: 'spatial' })
    const liveId = await resolveDocumentIdAtPath(WS, 'live')
    const app = await appWithRealDeps()

    const live = await app.request(`/api/workspaces/${WS}/trash/${liveId}`, { method: 'DELETE' })

    expect(live.status).toBe(404)
    expect(await resolveDocumentIdAtPath(WS, 'live')).toBe(liveId)
    expect(
      (
        await app.request(`/api/workspaces/${WS}/trash/01ARZ3NDEKTSV4RRFFQ69G5FAV`, {
          method: 'DELETE',
        })
      ).status,
    ).toBe(404)
  })

  it('an invalid workspaceId is a 400 request error, not a 500 server error', async () => {
    const app = await appWithRealDeps()

    const listed = await app.request('/api/workspaces/bad%20id/trash')
    expect(listed.status).toBe(400)
    const restored = await app.request(
      '/api/workspaces/bad%20id/trash/01ARZ3NDEKTSV4RRFFQ69G5FAV/restore',
      { method: 'POST' },
    )
    expect(restored.status).toBe(400)
    const purged = await app.request('/api/workspaces/bad%20id/trash/01ARZ3NDEKTSV4RRFFQ69G5FAV', {
      method: 'DELETE',
    })
    expect(purged.status).toBe(400)
  })

  it('a composition without the trash capability answers 501 on every trash route', async () => {
    // The default (in-memory) module binds an index with no listTrash /
    // restoreDocument, so the route finds no trash on it.
    const deps = resolveServerDeps(createContainer(storeMemoryModule))
    expect(hasDocumentTrash(deps.documentIndex)).toBe(false)
    // The workspace exists: an unknown one is refused before the capability
    // is consulted, so it would hide the 501 this case is about.
    await deps.documentIndex.createWorkspace({ workspaceId: 'ws' })
    const app = createDocumentRouter(testDocumentRouterOptions({ serverDeps: deps }))

    expect((await app.request('/api/workspaces/ws/trash')).status).toBe(501)
    expect(
      (
        await app.request('/api/workspaces/ws/trash/01ARZ3NDEKTSV4RRFFQ69G5FAV/restore', {
          method: 'POST',
        })
      ).status,
    ).toBe(501)
    expect(
      (
        await app.request('/api/workspaces/ws/trash/01ARZ3NDEKTSV4RRFFQ69G5FAV', {
          method: 'DELETE',
        })
      ).status,
    ).toBe(501)
  })

  // The guard in front of the document router answers an unknown workspace
  // first; the trash router's own translation is for one that vanishes after.
  it('the trash router alone answers an unknown workspace in the shared workspace voice', async () => {
    await prepareDataDir(tmp.dir)
    const db = await getDb(tmp.dir)
    const deps = resolveServerDeps(createContainer(createSelfHostStoreLocalModule(db, tmp.dir)))

    const res = await createTrashRouter({ serverDeps: deps }).request(
      '/api/workspaces/ws-nowhere/trash',
    )

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({
      error: 'workspace_not_found',
      message: 'Workspace "ws-nowhere" not found',
    })
  })

  it('unknown workspace answers 404 on list and purge; unknown documentId answers 404 on restore', async () => {
    const WS = 'ws-trash-missing'
    await saveDocument(WS, 'doc', canvasDoc('content'), { kind: 'spatial' })
    const app = await appWithRealDeps()

    expect((await app.request('/api/workspaces/ws-nowhere/trash')).status).toBe(404)
    expect(
      (
        await app.request('/api/workspaces/ws-nowhere/trash/01ARZ3NDEKTSV4RRFFQ69G5FAV', {
          method: 'DELETE',
        })
      ).status,
    ).toBe(404)
    expect(
      (
        await app.request(`/api/workspaces/${WS}/trash/01ARZ3NDEKTSV4RRFFQ69G5FAV/restore`, {
          method: 'POST',
        })
      ).status,
    ).toBe(404)
  })
})
